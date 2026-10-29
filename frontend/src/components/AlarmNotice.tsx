import {Alert} from '@gravity-ui/uikit';

import type {Clock} from '../api/types';
import {formatTime} from '../lib/format';

/** A confirmed violation is always an alarm; its cause belongs in the comment. */
export function AlarmNotice({reason, start, clock, source, cause}: {
    reason: string; start: number; clock: Clock; source?: string; cause?: string;
}) {
    const comment = cause && !reason.startsWith(cause) ? `${cause}. ${reason}` : reason;
    return <Alert className="alarm-notice" theme="danger" title="Тревога"
        message={`${source ? source + ' · ' : ''}${formatTime(start, clock)} · ${comment}`} />;
}
