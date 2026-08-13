import { MigrationRunner } from '../migrations/runner';

const databaseUrl=process.env.DATABASE_URL??(process.env.DATABASE_MIGRATION_PASSWORD?`postgresql://postgres:${encodeURIComponent(process.env.DATABASE_MIGRATION_PASSWORD)}@localhost/capere?host=%2Fcloudsql%2F${encodeURIComponent(process.env.CLOUD_SQL_INSTANCE??'')}`:'');
if(!databaseUrl)throw new Error('Migration database credentials are not set');
new MigrationRunner(databaseUrl,undefined,process.env.DATABASE_SSL_MODE==='disable').up().then(({applied})=>{for(const name of applied)console.warn(`applied  ${name}`);console.warn(applied.length?`${applied.length} migration(s) applied.`:'No pending migrations — database is up to date.');}).catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exit(1)});
