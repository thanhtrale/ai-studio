import { cloudWorker } from '../../../utils/cloud/worker';

export default defineEventHandler(async () => cloudWorker().stop());
