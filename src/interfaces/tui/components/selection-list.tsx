import { Select, type SelectProps } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useRef, type ReactNode } from 'react';
import { tuiColors } from '../theme.js';
import { displayWidth, padToDisplayWidth, truncateToDisplayWidth, wrapByDisplayWidth } from '../render/width.js';
import { literalMatch } from '../commands.js';
import type { UiDraft } from '../../../application/ports/ui-input-store.js';

export type SearchChoice = { readonly value: string; readonly label: string; readonly description?: string; readonly reason?: string | null; readonly current?: boolean };
export type DialogSelection = { readonly query: UiDraft; readonly selectedId: string | null };
export function filterChoices(choices: readonly SearchChoice[], query: string): readonly SearchChoice[] {
  return choices.filter(choice => literalMatch(query, choice.value, choice.label, choice.description ?? ''));
}
/** Pure picker: App owns keys and object selection, so child useInput cannot submit twice. */
export function SearchSelectionList({choices,selection,width,rows}:{readonly choices:readonly SearchChoice[];readonly selection:DialogSelection;readonly width:number;readonly rows:number}) {
  const filtered = filterChoices(choices,selection.query.text);
  const index = filtered.findIndex(choice => choice.value === selection.selectedId);
  const budget = Math.max(1, rows), start = Math.max(0,Math.min(filtered.length-budget,index-Math.floor(budget/2)));
  return <>
    <Text color={tuiColors.focus}>{truncateToDisplayWidth('搜索 › ' + (selection.query.text || '输入名称或 ID'), width)}</Text>
    <Box height={budget} flexDirection="column" overflow="hidden">
      {filtered.slice(start,start+budget).map(choice=><Text key={choice.value} inverse={choice.value===selection.selectedId} dimColor={Boolean(choice.reason)}>{truncateToDisplayWidth((choice.value===selection.selectedId?'› ':'  ')+choice.label+(choice.current?' ✔':'')+(choice.reason?' · 不可用: '+choice.reason:''),width)}</Text>)}
      {filtered.length===0?<Text dimColor>没有匹配项</Text>:index<0?<Text>所选项已变化，请重新选择</Text>:null}
    </Box>
  </>;
}

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
export function fieldRows(fields:readonly {label:string;value:string;group?:string}[],width:number):readonly string[] {
  const columns=width>=64?2:1,cellWidth=columns===1?width:Math.floor((width-2)/2),rows:string[]=[];
  for(let index=0;index<fields.length;){
    const left=fields[index],right=columns===2&&fields[index+1]?.group===left?.group?fields[index+1]:undefined;
    if(left?.group&&left.group!==fields[index-1]?.group)rows.push('── '+left.group+' ──');
    const a=left?wrapByDisplayWidth(left.label+' '+left.value,cellWidth):[];
    const b=right?wrapByDisplayWidth(right.label+' '+right.value,cellWidth):[];
    for(let row=0;row<Math.max(a.length,b.length);row++)rows.push(columns===1?a[row]??'':padToDisplayWidth(a[row]??'',cellWidth)+'  '+(b[row]??''));
    index+=right?2:1;
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

export function ReviewBody({lines,width,rows,scroll=0,tab=0,action=0,allowed,label,sections}:{
  readonly sections?:readonly {label:string;lines:readonly string[]}[];
  readonly lines:readonly string[];readonly width:number;readonly rows:number;readonly scroll?:number;
  readonly tab?:number;readonly action?:number;readonly allowed:boolean;readonly label:string;
}) {
  const selectedTab=sections?.[tab]??sections?.[0];
  const wrapped=(selectedTab?.lines??lines).flatMap(line=>wrapByDisplayWidth(line,Math.max(1,width-8)));
  const budget=Math.max(1,rows-11),start=Math.min(scroll,Math.max(0,wrapped.length-budget));
  const tabs=sections??[{label:'概要'},{label:'完整记录'}];
  const tabLabels=tabs.map((section,index)=>tab===index?'['+section.label+']':section.label).join('  ');
  const selected=wrapped.slice(start,start+budget);
  return <>
    <Text>{displayWidth(tabLabels)>width-8?'['+(tabs[tab]?.label??tabs[0]?.label??'概要')+'] · '+(tab+1)+'/'+tabs.length:tabs.map((section,index)=><Text key={section.label} color={tab===index?tuiColors.accent:tuiColors.muted}>{index>0?'  ':''}{tab===index?'['+section.label+']':section.label}</Text>)}</Text>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">{selected.map((line,index)=><Text key={index}>{line}</Text>)}</Box>
    <Text dimColor>{'─'.repeat(Math.max(1,width-8))}</Text>
    <Text dimColor>{truncateToDisplayWidth('当前操作：'+(action===0?'返回':allowed?label:'当前不可确认')+(wrapped.length>budget?' · 行 '+(start+1)+'–'+Math.min(start+budget,wrapped.length)+'/'+wrapped.length:''),Math.max(1,width-8))}</Text>
    <Text><Text inverse={action===0} color={tuiColors.accent}> 返回 </Text>{'  '}<Text inverse={action===1&&allowed} color={allowed?tuiColors.warning:tuiColors.muted}>{allowed?` ${label} `:' 当前不可确认 '}</Text></Text>
  </>;
}
