import * as yup from 'yup';

import * as YupHelpers from 'src/utils/yup/index';

export const enterInputSchema = yup.object().shape({
  email: YupHelpers.string('Email').email("Must be a valid email").required(),
});
