import { ServiceDatabase } from '@ecommerce/storage';

/** Users, refresh sessions and login throttling commit to this service's own database. */
export const database = new ServiceDatabase('auth');
