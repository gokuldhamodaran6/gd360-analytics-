import type { ReactNode } from "react";
import type { CheckboxListOption } from "./CheckboxList";
import { MultiSelectChips } from "./MultiSelectChips";

// The filter rail's multi-value control (Main.dc.html "Market segment",
// "Country"): a 36 px field that reads "Online TA, Offline TA/TO  +3  v"
// and opens a searchable checkbox list with counts and "Select all /
// Clear". Controlled: `options` ({value, label?, count?}), `value`
// (string[]), `onChange`; `onSearch` + `loading` hand the search to the
// warehouse. `variant="chip"` gives the filter-bar pill ("Market: PRT,
// GBR +3") instead of the field; `variant="chips"` the removable-tag field.

export type MultiSelectOption = CheckboxListOption;

export type MultiSelectProps = {
  options: MultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  onSearch?: (query: string) => void;
  loading?: boolean;
  label?: ReactNode;
  placeholder?: ReactNode;
  variant?: "field" | "chip" | "chips";
  // How many selected values to show before "+N".
  maxVisible?: number;
  searchPlaceholder?: string;
  emptyText?: ReactNode;
  width?: number | string;
  align?: "start" | "end";
  icon?: ReactNode;
  formatCount?: (count: number | string) => ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
};

export function MultiSelect({ value, variant = "field", ...rest }: MultiSelectProps) {
  return <MultiSelectChips selected={value} variant={variant} {...rest} />;
}
