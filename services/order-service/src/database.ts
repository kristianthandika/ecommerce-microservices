import { ServiceDatabase } from '@ecommerce/storage';
import { migrations } from './migrations.ts';

// Cart snapshots, checkout tickets and orders commit to this service's own database.
export const database = new ServiceDatabase('order', { migrations });
