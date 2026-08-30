import { app, ensureDemo } from './app.js';
import { pool } from './store.js';
import { renewExpiringWatches } from './calendar.js';

const port = Number(process.env.PORT || 3000);
await pool.query('SELECT 1');
await ensureDemo();
app.listen(port, '0.0.0.0', () => console.log(`Tmony is running at http://localhost:${port}`));

setInterval(() => void renewExpiringWatches(), 12 * 60 * 60 * 1000).unref();
