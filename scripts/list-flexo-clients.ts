import { getDb, getClientes } from '../lib/db';

const db = getDb();
const clientes = getClientes(db);
console.log(JSON.stringify(clientes.map(c => ({ carpeta: c.carpeta, nombre: c.nombre, activo: c.activo, prompt_preview: c.prompt?.slice(0, 250) })), null, 2));
