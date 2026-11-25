'use client';

import { Selector, type SelectorProps } from '@astryxdesign/core/Selector';
import { TextArea, type TextAreaProps } from '@astryxdesign/core/TextArea';
import { TextInput, type TextInputProps } from '@astryxdesign/core/TextInput';
import type { ApiError } from '@repairos/contracts';
import {
  Controller,
  type Control,
  type FieldValues,
  type Path,
  type UseFormSetError,
} from 'react-hook-form';

export const errorStatus = (message: string | undefined) =>
  message ? { type: 'error' as const, message } : undefined;

/** `TOut` is the form's transformed (resolver output) type; fields only read raw values. */
type Bound<T extends FieldValues, TOut> = { control: Control<T, unknown, TOut>; name: Path<T> };

/** TextInput bound to a react-hook-form field holding a string. */
export function FormTextInput<T extends FieldValues, TOut = T>({
  control,
  name,
  ...props
}: Bound<T, TOut> & Omit<TextInputProps, 'value' | 'onChange' | 'onBlur' | 'htmlName' | 'status'>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <TextInput
          {...props}
          value={(field.value as string | null | undefined) ?? ''}
          onChange={(v) => field.onChange(v)}
          onBlur={field.onBlur}
          ref={field.ref}
          htmlName={field.name}
          status={errorStatus(fieldState.error?.message)}
        />
      )}
    />
  );
}

/** TextArea bound to a string field. */
export function FormTextArea<T extends FieldValues, TOut = T>({
  control,
  name,
  ...props
}: Bound<T, TOut> & Omit<TextAreaProps, 'value' | 'onChange' | 'onBlur' | 'htmlName' | 'status'>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <TextArea
          {...props}
          value={(field.value as string | null | undefined) ?? ''}
          onChange={(v) => field.onChange(v)}
          onBlur={field.onBlur}
          ref={field.ref}
          htmlName={field.name}
          status={errorStatus(fieldState.error?.message)}
        />
      )}
    />
  );
}

interface FormSelectorProps {
  label: string;
  options: SelectorProps['options'];
  isClearable?: boolean;
  description?: string;
  placeholder?: string;
  isReadOnly?: boolean;
  isDisabled?: boolean;
  isOptional?: boolean;
  isRequired?: boolean;
  hasSearch?: boolean;
  width?: SelectorProps['width'];
}

/** Selector bound to a string field; "" means nothing chosen. */
export function FormSelector<T extends FieldValues, TOut = T>({
  control,
  name,
  isClearable = false,
  ...props
}: Bound<T, TOut> & FormSelectorProps) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const value = (field.value as string | null | undefined) || null;
        const common = {
          ...props,
          htmlName: field.name,
          status: errorStatus(fieldState.error?.message),
        };
        return isClearable ? (
          <Selector {...common} hasClear value={value} onChange={(v) => field.onChange(v ?? '')} />
        ) : (
          <Selector
            {...common}
            value={value ?? undefined}
            onChange={(v) => field.onChange(v ?? '')}
          />
        );
      }}
    />
  );
}

/** Map API `issues[]` onto form fields (first path segment). Returns true if any matched. */
export function applyApiIssues<T extends FieldValues>(
  body: ApiError,
  fields: readonly string[],
  setError: UseFormSetError<T>,
): boolean {
  let matched = false;
  for (const issue of body.issues ?? []) {
    const field = issue.path[0];
    if (typeof field === 'string' && fields.includes(field)) {
      setError(field as Path<T>, { type: 'server', message: issue.message });
      matched = true;
    }
  }
  return matched;
}
