import { ImapFlow } from "imapflow";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });

const config = {
  host: process.env.EMAIL_HOST || "",
  port: Number(process.env.EMAIL_PORT || 993),
  user: process.env.EMAIL_USER || "",
  pass: process.env.EMAIL_PASS || "",
};

async function listFolder(imap: ImapFlow, folder: string) {
  try {
    const lock = await imap.getMailboxLock(folder);
    try {
      const msgs: Array<{uid: number, subject: string}> = [];
      for await (const msg of imap.fetch("1:*", { uid: true, envelope: true })) {
        msgs.push({ uid: msg.uid, subject: msg.envelope?.subject ?? "(sin asunto)" });
      }
      console.log(`\n📁 ${folder} (${msgs.length} correos):`);
      for (const m of msgs) console.log(`   uid=${m.uid} | ${m.subject.slice(0,60)}`);
    } finally {
      lock.release();
    }
  } catch (e) {
    console.log(`\n📁 ${folder}: ERROR - ${e}`);
  }
}

async function main() {
  const imap = new ImapFlow({
    host: config.host, port: config.port, secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });
  await imap.connect();
  await listFolder(imap, "A A EN PROCESO IA");
  await listFolder(imap, "A A INGRESADO");
  await listFolder(imap, "A A REVISAR IA");
  await imap.logout();
}

main().catch(console.error);
