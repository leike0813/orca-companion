import { Box, useBoxMetrics, type DOMElement } from 'ink';
import { useEffect, useRef, type ReactNode } from 'react';
import { Transcript, type TranscriptProps } from './transcript.js';

/** Shared bounded conversation region; coordination and debug supply their own controls. */
export function Conversation(props: TranscriptProps & {
  readonly width: number;
  readonly height: number;
  readonly children: ReactNode;
  readonly onTranscriptHeight?: (height: number) => void;
}) {
  const ref = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(ref);
  const height = metrics.hasMeasured ? Math.max(1, Math.round(metrics.height)) : props.maxLines ?? Math.max(1, props.height - 12);
  useEffect(() => { if (metrics.hasMeasured) props.onTranscriptHeight?.(height); }, [metrics.hasMeasured, height, props.onTranscriptHeight]);
  return <Box flexDirection="column" width={props.width} height={props.height}>
    <Box ref={ref} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={1} overflow="hidden">
      <Transcript {...props} maxLines={height}/>
    </Box>
    {props.children}
  </Box>;
}
