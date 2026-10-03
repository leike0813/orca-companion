import { Select, type SelectProps } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useRef, type ReactNode } from 'react';
import { tuiColors } from '../theme.js';
import { padToDisplayWidth, truncateToDisplayWidth, wrapByDisplayWidth } from '../render/width.js';

type SelectionListProps = Pick<SelectProps, 'options' | 'defaultValue' | 'isDisabled' | 'visibleOptionCount'> & {
  readonly onSelect: (value: string) => void;
};

/** Select 只对新值调用 onChange；再次按 Enter 仍须能确认当前项或重试被拒绝的选择。 */
export function SelectionList({ options, defaultValue, isDisabled = false, visibleOptionCount = 6, onSelect }: SelectionListProps) {
  const focusedIndex = useRef(Math.max(0, options.findIndex(option => option.value === defaultValue)));
  const lastSubmitted = useRef(defaultValue ?? null);

  useInput((_input, key) => {
    if (key.downArrow) focusedIndex.current = Math.min(options.length - 1, focusedIndex.current + 1);
    if (key.upArrow) focusedIndex.current = Math.max(0, focusedIndex.current - 1);
    if (key.return) {
      const focused = options[focusedIndex.current]?.value;
      if (focused !== undefined && focused === lastSubmitted.current) onSelect(focused);
    }
  }, { isActive: !isDisabled });

  return (
    <Select
      options={options}
      visibleOptionCount={visibleOptionCount}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      isDisabled={isDisabled}
      onChange={(value) => {
        lastSubmitted.current = value;
        onSelect(value);
      }}
    />
  );
}

export type ReviewLayoutProps = {
  readonly rows?: number;
  readonly tab?: number;
  readonly scroll?: number;
  readonly action?: number;
};

/** Trusted fields share the same responsive columns; long values remain scrollable. */
export function fieldRows(fields:readonly {label:string;value:string}[],width:number):readonly string[] {
  const columns=width>=64?2:1,cellWidth=columns===1?width:Math.floor((width-2)/2),rows:string[]=[];
  for(let index=0;index<fields.length;index+=columns){
    const left=fields[index],right=columns===2?fields[index+1]:undefined;
    const a=left?wrapByDisplayWidth(left.label+' '+left.value,cellWidth):[];
    const b=right?wrapByDisplayWidth(right.label+' '+right.value,cellWidth):[];
    for(let row=0;row<Math.max(a.length,b.length);row++)rows.push(columns===1?a[row]??'':padToDisplayWidth(a[row]??'',cellWidth)+'  '+(b[row]??''));
  }
  return rows;
}

export function DialogFrame({title,summary,width,rows=16,footer,children}:{
  readonly title:string;readonly summary:string;readonly width:number;readonly rows?:number;
  readonly footer:string;readonly children:ReactNode;
}) {
  const inner=Math.max(1,width-8);
  return <Box marginX={2} width={Math.max(1,width-4)} height={rows} borderStyle="round" borderColor={tuiColors.border} paddingX={1} flexDirection="column">
    <Text color={tuiColors.accent} bold>{truncateToDisplayWidth(title,inner)}</Text>
    <Text dimColor>{truncateToDisplayWidth(summary,inner)}</Text>
    <Text dimColor>{'─'.repeat(inner)}</Text>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">{children}</Box>
    <Text dimColor>{truncateToDisplayWidth(footer,inner)}</Text>
  </Box>;
}

export function ReviewBody({lines,width,rows,scroll=0,tab=0,action=0,allowed,label}:{
  readonly lines:readonly string[];readonly width:number;readonly rows:number;readonly scroll?:number;
  readonly tab?:number;readonly action?:number;readonly allowed:boolean;readonly label:string;
}) {
  const wrapped=lines.flatMap(line=>wrapByDisplayWidth(line,Math.max(1,width-8)));
  const budget=Math.max(1,rows-10),start=Math.min(scroll,Math.max(0,wrapped.length-budget));
  // Two views of the same trusted fields: summary and complete scrollable record.
  const selected=tab===0?wrapped.slice(0,budget):wrapped.slice(start,start+budget);
  return <>
    <Text><Text color={tab===0?tuiColors.accent:tuiColors.muted}>概要</Text>{'  '}<Text color={tab===1?tuiColors.accent:tuiColors.muted}>完整记录</Text></Text>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">{selected.map((line,index)=><Text key={index}>{line}</Text>)}</Box>
    <Text dimColor>{truncateToDisplayWidth('当前操作：'+(action===0?'返回':allowed?label:'当前不可确认'),Math.max(1,width-8))}</Text>
    <Text><Text inverse={action===0} color={tuiColors.accent}> 返回 </Text>{'  '}<Text inverse={action===1&&allowed} color={allowed?tuiColors.warning:tuiColors.muted}>{allowed?` ${label} `:' 当前不可确认 '}</Text></Text>
  </>;
}
