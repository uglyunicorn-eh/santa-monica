import * as yup from 'yup';

import * as YupHelpers from 'src/utils/yup/index';

export const createPartyInputSchema = yup.object().shape({
  name: YupHelpers.string('Party name').max(100).required(),
  password: YupHelpers.password('Secret phrase').max(100),
});

export const joinPartyInputSchema = yup.object().shape({
  party: YupHelpers.string('Party ID').max(100).required(),
  name: YupHelpers.string('Name').max(100).required(),
  password: YupHelpers.string('Password').max(100),
});

export const leavePartyInputSchema = yup.object().shape({
  party: YupHelpers.string('Party ID').max(100).required(),
});

export const closePartyInputSchema = yup.object().shape({
  party: YupHelpers.string('Party ID').max(100).required(),
});
