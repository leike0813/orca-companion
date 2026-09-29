import { Select, type SelectProps } from '@inkjs/ui';
import { useInput } from 'ink';
import { useRef } from 'react';

type SelectionListProps = Pick<SelectProps, 'options' | 'defaultValue' | 'isDisabled'> & {
  readonly onSelect: (value: string) => void;
};

/** Select 只对新值调用 onChange；再次按 Enter 仍须能确认当前项或重试被拒绝的选择。 */
export function SelectionList({ options, defaultValue, isDisabled = false, onSelect }: SelectionListProps) {
  const focusedIndex = useRef(0);
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
      {...(defaultValue === undefined ? {} : { defaultValue })}
      isDisabled={isDisabled}
      onChange={(value) => {
        lastSubmitted.current = value;
        onSelect(value);
      }}
    />
  );
}
