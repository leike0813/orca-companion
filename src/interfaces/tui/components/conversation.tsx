import { Box, useBoxMetrics, type DOMElement } from 'ink';
import { useEffect, useRef, type ReactNode } from 'react';
import { Transcript, type TranscriptProps } from './transcript.js';
import type { TranscriptRegion } from '../input/transcript-mouse.js';

/** Shared bounded conversation region; coordination and debug supply their own controls. */
export function Conversation(props: TranscriptProps & {
  readonly width: number;
  readonly height: number;
  readonly children: ReactNode;
  readonly onTranscriptHeight?: (height: number) => void;
  readonly origin?: { readonly x: number; readonly y: number };
  readonly onTranscriptRegion?: (region: TranscriptRegion | null) => void;
}) {
  const ref = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(ref);
  const height = metrics.hasMeasured ? Math.max(1, Math.round(metrics.height)) : props.maxLines ?? Math.max(1, props.height - 12);
  useEffect(() => { if (metrics.hasMeasured) props.onTranscriptHeight?.(height); }, [metrics.hasMeasured, height, props.onTranscriptHeight]);
  useEffect(() => {
    props.onTranscriptRegion?.(metrics.hasMeasured ? {
      x: (props.origin?.x ?? 0) + metrics.left, y: (props.origin?.y ?? 0) + metrics.top,
      width: metrics.width, height: metrics.height,
    } : null);
    return () => props.onTranscriptRegion?.(null);
  }, [metrics.hasMeasured, metrics.left, metrics.top, metrics.width, metrics.height,
    props.origin?.x, props.origin?.y, props.onTranscriptRegion]);
  return <Box flexDirection="column" width={props.width} height={props.height}>
    <Box ref={ref} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={1} overflow="hidden">
      <Transcript {...props} maxLines={height}/>
    </Box>
    {props.children}
  </Box>;
}
