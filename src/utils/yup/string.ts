import * as yup from 'yup';

export default function string(label: string): yup.StringSchema {
  return yup
    .string()
    .label(label)
    .trim()
    .transform(v => v.replace(/\s+/g, ' ').replace(/\s([.,!?])/g, '$1'));
}
