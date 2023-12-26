import * as yup from 'yup';

export default function password(label: string) {
  return yup
    .string()
    .label(label)
    .trim();
}
