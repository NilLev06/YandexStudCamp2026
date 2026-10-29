"""SMD evaluation in sample indices, without assuming an acquisition period."""
from __future__ import annotations

import hashlib
import math
from pathlib import Path

from ..engine.single import SINGLE_CONFIG, SingleMonitor

SIGMA_FLOOR = 0.01  # One percent of SMD's published normalized scale, fixed before evaluation.
SMD_CONFIG = {**SINGLE_CONFIG, 'range_min': -math.inf, 'range_max': math.inf,
              'max_rate': math.inf, 'min_spread': 0}


def read_matrix(path: Path, features: int = 38) -> list[list[float]]:
    rows = []
    for index, line in enumerate(path.read_text().splitlines(), start=1):
        row = [float(v) for v in line.split(',')]
        if len(row) != features or not all(math.isfinite(v) for v in row):
            raise ValueError(f'{path}: row {index} must have {features} finite values')
        rows.append(row)
    if not rows:
        raise ValueError(f'{path}: empty matrix')
    return rows


def fit_profiles(training: list[list[float]], sigma_floor: float = SIGMA_FLOOR) -> list[dict]:
    if not training or not training[0] or not math.isfinite(sigma_floor) or sigma_floor <= 0:
        raise ValueError('Nonempty training data and a positive finite sigma floor are required')
    width = len(training[0])
    if any(len(row) != width or not all(math.isfinite(v) for v in row) for row in training):
        raise ValueError('Training rows must have the same finite columns')
    result = []
    for column in zip(*training):
        mean = sum(column) / len(column)
        sigma = math.sqrt(sum((v - mean) ** 2 for v in column) / len(column))
        result.append({'mean': mean, 'sigma': max(sigma, sigma_floor)})
    return result


def predict(rows: list[list[float]], profiles: list[dict]) -> list[bool]:
    if not profiles or any(len(row) != len(profiles) or not all(math.isfinite(v) for v in row) for row in rows):
        raise ValueError('Each evaluation row must match the calibrated channels')
    monitors = [SingleMonitor(config=SMD_CONFIG, profiles={'A': profile}) for profile in profiles]
    predictions = []
    for index, row in enumerate(rows):
        alarm = False
        for value, monitor in zip(row, monitors):
            frame = monitor.tick(index, [{'event_time': index, 'received_at': index,
                                          'value': value, 'mode': 'A', 'quality_flags': 'valid'}])
            alarm |= bool(frame['alarms'])
        predictions.append(alarm)
    return predictions


def score(predictions: list[bool], labels: list[int]) -> dict:
    if len(predictions) != len(labels) or any(v not in (0, 1) for v in labels):
        raise ValueError('One binary reference label is required per prediction')
    tp = sum(bool(p) and y == 1 for p, y in zip(predictions, labels))
    fp = sum(bool(p) and y == 0 for p, y in zip(predictions, labels))
    fn = sum(not p and y == 1 for p, y in zip(predictions, labels))
    tn = len(labels) - tp - fp - fn
    delays = []
    events = 0
    index = 0
    while index < len(labels):
        if labels[index] == 0:
            index += 1
            continue
        start = index
        while index < len(labels) and labels[index] == 1:
            index += 1
        events += 1
        detected = next((t for t in range(start, index) if predictions[t]), None)
        if detected is not None:
            delays.append(detected - start)
    return {'samples': len(labels), 'anomaly_points': sum(labels), 'alarm_points': tp + fp,
            'tp': tp, 'fp': fp, 'fn': fn, 'tn': tn,
            'point_precision': tp / (tp + fp) if tp + fp else 0.0,
            'point_recall': tp / (tp + fn) if tp + fn else 0.0,
            'false_positive_rate': fp / (fp + tn) if fp + tn else 0.0,
            'event_total': events, 'event_detected': len(delays), 'event_delays_samples': delays,
            'prediction_sha256': hashlib.sha256(bytes(bool(p) for p in predictions)).hexdigest()}


def replay_metrics(rows: list[list[float]], profiles: list[dict], labels: list[int]) -> dict:
    # Finish prediction before the evaluator sees reference labels.
    predictions = predict(rows, profiles)
    return {'channels': len(profiles), **score(predictions, labels)}
