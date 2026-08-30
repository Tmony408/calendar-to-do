import fs from 'node:fs/promises';
import { pool } from './store.js';

const sql = await fs.readFile(new URL('../schema.sql', import.meta.url), 'utf8');
await pool.query(sql);
await pool.end();
console.log('Database migration complete.');
