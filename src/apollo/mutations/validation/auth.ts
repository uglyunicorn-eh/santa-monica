import * as yup from 'yup';

import * as YupHelpers from 'src/utils/yup/index';

export const enterRequestInputSchema = yup.object().shape({
  email: YupHelpers.string('Email').email("Must be a valid email").required(),
  party: YupHelpers.string('Party Code').matches(/^[QWERTYUIPASDFGHJKLZXCVBNMO]{5}$/, "Invalid party code").notRequired(),
});

export const enterInputSchema = yup.object().shape({
  enterRequestToken: YupHelpers.string('Enter request token').required(),
});
