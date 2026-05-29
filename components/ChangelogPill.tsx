"use client";

import { ChangelogPill as DSChangelogPill } from "@ai4u/design-system/changelog";

/**
 * Pill de changelog (esquina inferior derecha) conectado al servicio central.
 * MULTITENANT: el tenant viene de NEXT_PUBLIC_CHANGELOG_CLIENT (config de deploy),
 * nunca hardcodeado. Si no está seteado, no renderiza nada.
 *
 * Reemplaza al antiguo VersionTag local. Env:
 *   NEXT_PUBLIC_CHANGELOG_CLIENT  (requerido)  tenant/clientId en el servicio
 *   NEXT_PUBLIC_CHANGELOG_APP     (opcional)   override del appId
 *   NEXT_PUBLIC_CHANGELOG_URL     (opcional)   override de la URL del servicio
 */
// OrderLoader se registra en el servicio como client "orderloader", appId "web".
const APP_ID = "web";

export function ChangelogPill() {
  const client = process.env.NEXT_PUBLIC_CHANGELOG_CLIENT;
  if (!client) return null;
  return (
    <div style={{ position: "fixed", bottom: 16, right: 16, zIndex: 1000 }}>
      <DSChangelogPill
        client={client}
        app={process.env.NEXT_PUBLIC_CHANGELOG_APP || APP_ID}
        serviceUrl={process.env.NEXT_PUBLIC_CHANGELOG_URL || undefined}
      />
    </div>
  );
}

export default ChangelogPill;
