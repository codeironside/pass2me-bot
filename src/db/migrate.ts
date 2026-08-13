import { loadDotEnvFile, applyDevEnvDefaults } from '../config/dotenv';
import { loadEnv, resetEnvCache } from '../config/env';
import { closeDb, getDb, runMigrations } from './client';

loadDotEnvFile();
applyDevEnvDefaults();
resetEnvCache();
loadEnv();
runMigrations(getDb());
closeDb();
console.log('Migrations complete.');
