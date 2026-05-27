import { getDb, getClientes } from '../lib/db';

const carpeta = process.argv[2];
const db = getDb();
const clientes = getClientes(db);
const c = clientes.find(x => x.carpeta === carpeta);
if (!c) {
  console.error('No encontrado:', carpeta);
  console.log('Disponibles:', clientes.map(x => x.carpeta).join(', '));
  process.exit(1);
}
console.log(c.prompt);
