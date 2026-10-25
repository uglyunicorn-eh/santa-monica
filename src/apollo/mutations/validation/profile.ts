import * as yup from 'yup';

import * as YupHelpers from 'src/utils/yup/index';

export const updateNameInputSchema = yup.object().shape({
  name: YupHelpers.string('Name').max(100).required(),
});
