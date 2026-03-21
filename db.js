import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Проверка подключения
pool.on('connect', () => {
  console.log('Connected to PostgreSQL');
});

export const query = (text, params) => pool.query(text, params);