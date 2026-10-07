// GD360 design-system kit (2026-10-06/07, System.dc.html + DESIGN_BRIEF.md).
// One file per component; screens compose these and add nothing of their
// own. Tokens live in src/index.css and tailwind.config.js; tokens.ts
// exports the hex values chart code needs. The chart series palette stays
// in src/lib/chartStyle.ts (SIGNATURE_COLORS) - re-exported, never
// duplicated. See README.md in this folder for the component list.

export { cn } from "./cn";
export type { ClassValue } from "./cn";
export { TONE_CLASSES, TONE_DOT_CLASSES, TONE_TEXT_CLASSES } from "./tones";
export type { Tone } from "./tones";
export * from "./tokens";

export * from "./Icons";

// Buttons
export { Button, buttonClasses } from "./Button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./Button";
export { IconButton } from "./IconButton";
export type { IconButtonProps } from "./IconButton";

// Forms
export { Field, FieldHint, Label, useFieldContext } from "./Field";
export type { FieldProps } from "./Field";
export { Input, NumberInput, SearchInput, Textarea, inputBaseClasses, inputStateClasses } from "./Input";
export type { InputProps, NumberInputProps, SearchInputProps, TextareaProps } from "./Input";
export { Select, MenuSelect, Listbox } from "./Select";
export type { SelectOption, SelectProps, MenuSelectProps } from "./Select";
export { Checkbox } from "./Checkbox";
export type { CheckboxProps } from "./Checkbox";
export { Switch } from "./Switch";
export type { SwitchProps } from "./Switch";

// Filters
export { SegmentedControl } from "./SegmentedControl";
export type { SegmentedControlProps, SegmentOption } from "./SegmentedControl";
export { FilterChip } from "./FilterChip";
export type { FilterChipProps } from "./FilterChip";
export { ChipGroup } from "./ChipGroup";
export type { ChipGroupProps } from "./ChipGroup";
export { CheckboxList, labelText, optionLabelNode } from "./CheckboxList";
export type { CheckboxListOption, CheckboxListProps } from "./CheckboxList";
export { MultiSelect } from "./MultiSelect";
export type { MultiSelectOption, MultiSelectProps } from "./MultiSelect";
export { MultiSelectChips } from "./MultiSelectChips";
export type { MultiSelectChipsProps } from "./MultiSelectChips";
export { OptionSearch } from "./OptionSearch";
export type { OptionSearchProps } from "./OptionSearch";
export { DateRangePicker, DEFAULT_PRESETS, DATA_ANCHOR_AFTER_DAYS, presetAnchor } from "./DateRangePicker";
export type { DateRange, DateRangePickerProps, DateRangePreset } from "./DateRangePicker";
export * as dateUtils from "./dateUtils";
export { RangeSlider } from "./RangeSlider";
export type { RangeSliderProps } from "./RangeSlider";
export { SavedViewSelect } from "./SavedViewSelect";
export type { SavedView, SavedViewSelectProps } from "./SavedViewSelect";
export { ResetFiltersLine } from "./ResetFiltersLine";
export type { ResetFiltersLineProps } from "./ResetFiltersLine";
export { FilterRail, FilterRailSection } from "./FilterRail";
export type { FilterRailProps, FilterRailSectionProps } from "./FilterRail";

// Cards, tiles, charts
export { Card } from "./Card";
export type { CardProps } from "./Card";
export { KpiTile, DeltaPill, formatDelta } from "./KpiTile";
export type { KpiTileProps, KpiDelta } from "./KpiTile";
export { Sparkline, downsample, SPARKLINE_MAX_POINTS } from "./Sparkline";
export type { SparklineProps } from "./Sparkline";
export { ChartCard, ChartShimmer, ComputedFooter } from "./ChartCard";
export type { ChartCardProps, ComputedFooterProps } from "./ChartCard";
export { ComputedIn, providerDisplayName, isFileProvider, formatDuration } from "./ComputedIn";
export type { ComputedInProps } from "./ComputedIn";

// Badges
export { StatusPill } from "./StatusPill";
export type { StatusPillProps } from "./StatusPill";
export { Badge } from "./Badge";
export type { BadgeProps, BadgeVariant } from "./Badge";
export { ProviderBadge } from "./ProviderBadge";
export type { ProviderBadgeProps } from "./ProviderBadge";
export { Tag } from "./Tag";
export type { TagProps } from "./Tag";
export { Avatar, initialsOf } from "./Avatar";
export type { AvatarProps } from "./Avatar";

// Overlays
export { Popover } from "./Popover";
export type { PopoverProps, PopoverTriggerApi } from "./Popover";
export { Sheet } from "./Sheet";
export type { SheetProps } from "./Sheet";
export { ConfirmDialog } from "./ConfirmDialog";
export type { ConfirmDialogProps } from "./ConfirmDialog";
export { Tooltip } from "./Tooltip";
export type { TooltipProps } from "./Tooltip";
export { Skeleton } from "./Skeleton";
export type { SkeletonProps } from "./Skeleton";

// Tables
export { DataTableFrame, PaginationFooter, DataTableFrame as TableFrame, PaginationFooter as TableFooter } from "./DataTableFrame";
export type {
  DataTableColumn, DataTableFrameProps, PaginationFooterProps,
  DataTableFrameProps as TableFrameProps, PaginationFooterProps as TableFooterProps,
} from "./DataTableFrame";

// Chrome
export { TopBar, TopBarSearch, Breadcrumb } from "./TopBar";
export type { TopBarProps, TopBarSearchProps, BreadcrumbItem, BreadcrumbProps } from "./TopBar";
