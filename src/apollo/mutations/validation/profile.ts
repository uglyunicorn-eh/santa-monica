import * as yup from 'yup';

import * as YupHelpers from 'src/utils/yup/index';

export const updateNameInputSchema = yup.object().shape({
  name: YupHelpers.string('Name').max(100).required(),
});

export const requestAccountDeletionInputSchema = yup.object().shape({
  requestId: YupHelpers.string('Request ID').max(100),
});

export const confirmTokenInputSchema = yup.object().shape({
  token: YupHelpers.string('Token').required(),
});

export const requestEmailChangeInputSchema = yup.object().shape({
  email: YupHelpers.string('Email').email('Must be a valid email').max(128).required(),
  requestId: YupHelpers.string('Request ID').max(100),
});
