/**
 * Test de conexión IMAP para FlexoImpresos.
 * Conecta, lista carpetas, cuenta mensajes en INBOX (total y no leídos),
 * y compara con las carpetas que OrderLoader necesita.
 */

import { ImapFlow } from 'imapflow';

// Carpetas que step0-download.ts necesita en el buzón
const REQUIRED_FOLDERS = [
  'INBOX.A A REVISAR IA',   // STAGING_FOLDER
  'INBOX.A A SANDRA',       // SANDRA_FOLDER
];

async function main() {
  const client = new ImapFlow({
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: {
      user: 'Pedidos@flexoimpresos.com',
      pass: 'Flexo2012*.',
    },
    logger: false,
  });

  console.log('=== Test IMAP FlexoImpresos ===\n');

  // 1. Conectar
  console.log('Conectando a outlook.office365.com:993 ...');
  try {
    await client.connect();
    console.log('✓ Conexión establecida\n');
  } catch (err) {
    console.error('✗ Error de conexión:', String(err));
    process.exit(1);
  }

  // 2. Listar todas las carpetas / mailboxes
  console.log('--- Carpetas disponibles ---');
  let allFolders: string[] = [];
  try {
    const list = await client.list();
    for (const box of list) {
      allFolders.push(box.path);
      console.log(' ', box.path, box.flags ? `[${[...box.flags].join(', ')}]` : '');
    }
    console.log(`\nTotal carpetas: ${list.length}\n`);
  } catch (err) {
    console.error('✗ Error listando carpetas:', String(err));
  }

  // 3. Status de INBOX: total de mensajes
  console.log('--- Status INBOX ---');
  try {
    const status = await client.status('INBOX', { messages: true, unseen: true });
    console.log(`  Total mensajes : ${status.messages}`);
    console.log(`  No leídos (unseen del status): ${status.unseen ?? 'n/d'}`);
  } catch (err) {
    console.error('✗ Error en status INBOX:', String(err));
  }

  // 4. Contar no leídos con search dentro del lock
  console.log('\n--- Búsqueda de no leídos en INBOX (seen: false) ---');
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const unseenUids = await client.search({ seen: false }, { uid: true });
      console.log(`  Mensajes no leídos (UID list): ${unseenUids.length}`);
      if (unseenUids.length > 0 && unseenUids.length <= 20) {
        console.log(`  UIDs: ${unseenUids.join(', ')}`);
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error('✗ Error buscando no leídos:', String(err));
  }

  // 5. Comparar carpetas requeridas por OrderLoader
  console.log('\n--- Carpetas requeridas por OrderLoader ---');
  for (const required of REQUIRED_FOLDERS) {
    const exists = allFolders.includes(required);
    const role = required === 'INBOX.A A REVISAR IA'
      ? 'STAGING_FOLDER (destino normal de OC)'
      : 'SANDRA_FOLDER (destino para correos sin OC o con extras)';
    console.log(`  ${exists ? '✓ EXISTE' : '✗ FALTA '} "${required}"  →  ${role}`);
  }

  const missing = REQUIRED_FOLDERS.filter(f => !allFolders.includes(f));
  if (missing.length === 0) {
    console.log('\n✓ Todas las carpetas requeridas ya existen. No hay nada que crear.');
  } else {
    console.log(`\n✗ Hay que crear ${missing.length} carpeta(s):`);
    for (const m of missing) console.log(`    - "${m}"`);
    console.log('\n  OrderLoader las crea automáticamente con mailboxCreate() en el primer run de step0.');
  }

  // 6. Logout limpio
  await client.logout();
  console.log('\n✓ Logout OK');
}

main().catch(err => {
  console.error('Error inesperado:', err);
  process.exit(1);
});
