"""The overview uses the same detector as /single, with the gateway's profiles.

Only legacy API names are adapted: level -> quality and invalid -> flags.
"""
from dataclasses import dataclass
from typing import Callable

from .monitor import CONFIG, PROFILES, Frame, Incident
from .single import ALARM_NAMES, SINGLE_CONFIG, SingleMonitor

LIVE_CONFIG = {**CONFIG, **SINGLE_CONFIG, 'flagsRecover': 2, 'freshConfirm': 6,
               'qualityRecover': 2, 'confirmWindows': 1}
TYPE_NAMES = {'level': 'quality', 'invalid': 'flags'}
LIVE_ALARMS = {TYPE_NAMES.get(k, k): v for k, v in ALARM_NAMES.items()}


@dataclass
class LiveIncident(Incident):
    highlight_end: float | None = None

    def as_dict(self):
        return {**super().as_dict(), 'highlight_end': self.highlight_end}


@dataclass
class LiveFrame(Frame):
    alarm_count: int = 0
    comment: str = ''


class LiveMonitor:
    def __init__(self):
        self.core = SingleMonitor(profiles=PROFILES)
        self.on_event: Callable | None = None
        self.incidents: list[LiveIncident] = []
        self.events: list[dict] = []
        self.accepted = self.late_count = 0
        self.last_aggregate_time = None

    def tick(self, now, incoming):
        incoming = list(incoming)
        new_times = set()
        for message in incoming:
            t = message['event_time']
            if t not in self.core.seen and t not in new_times:
                new_times.add(t)
                self.accepted += 1
                self.late_count += now - t > SINGLE_CONFIG['lateness']
        previous_window = self.core.last_window
        result = self.core.tick(now, incoming)
        known_ids = {i.id: i for i in self.incidents}
        for item in self.core.incidents:
            incident = known_ids.get(item['id'])
            if incident is None:
                incident = LiveIncident(item['id'], TYPE_NAMES.get(item['type'], item['type']),
                                        item['start'], item['end'], item['reason'])
                self.incidents.append(incident)
            incident.end = item['end']
            incident.highlight_end = item.get('highlight_end')
        for e in self.core.events:
            event = {**e, 'type': TYPE_NAMES.get(e['type'], e['type'])}
            self.events.append(event)
            if self.on_event:
                self.on_event(event)
        self.core.events.clear()
        end = self.core.last_window * SINGLE_CONFIG['window']
        if (previous_window is not None and self.core.last_window > previous_window
                and self.core.mode in PROFILES
                and len(self.core._values(end - SINGLE_CONFIG['window'], end)) >= 2):
            self.last_aggregate_time = end - 1
        open_types = {i.type for i in self.incidents if i.end is None}
        availability = 'stale' if 'availability' in open_types else 'unknown' if result['age'] is None else 'fresh'
        quality = ('alarm' if open_types - {'availability', 'flags'} else
                   'unknown' if availability != 'fresh' or self.core.mode not in PROFILES
                   or self.last_aggregate_time is None or now - self.last_aggregate_time > 2 * SINGLE_CONFIG['window'] else
                   'suspect' if result['status'] == 'suspect' else 'normal')
        return LiveFrame(now=now, mode=self.core.mode or '—', mode_known=self.core.mode in PROFILES,
                         s=result['s'], z=self.core.recent_z[-1] if self.core.recent_z else 0,
                         aggregate=result['aggregate'], aggregate_time=self.last_aggregate_time,
                         quality=quality, availability=availability,
                         flags='degraded' if 'flags' in open_types else 'ok', age=result['age'],
                         since_receipt=result['since_receipt'], late_count=self.late_count,
                         accepted=self.accepted, events=len(self.events),
                         alarm_count=len(open_types), comment=result['comment'])


def replay_live(scenario, seed):
    """Offline reference for the current overview/telemetry rules."""
    from .scenarios import generate
    result = generate(scenario, seed)
    monitor = LiveMonitor()
    cursor = 0
    frames = []
    for now in range(result['duration'] + 1):
        incoming = []
        while cursor < len(result['messages']) and result['messages'][cursor]['received_at'] <= now:
            incoming.append(result['messages'][cursor])
            cursor += 1
        frames.append(monitor.tick(now, incoming).as_dict())
    return {**result, 'frames': frames, 'incidents': [i.as_dict() for i in monitor.incidents],
            'events': monitor.events}
