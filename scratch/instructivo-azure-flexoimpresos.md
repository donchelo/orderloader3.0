# Configuración Azure AD — OrderLoader para FlexoImpresos

**Para:** Administrador de sistemas / IT FlexoImpresos  
**Tiempo estimado:** 15 minutos  
**Requisito:** Acceso a [portal.azure.com](https://portal.azure.com) con una cuenta que tenga rol de **Application Administrator** o superior.

---

## ¿Para qué es esto?

Estamos configurando un sistema llamado **OrderLoader** que lee automáticamente los correos de `Pedidos@flexoimpresos.com`, detecta órdenes de compra de clientes e ingresa los pedidos en SAP B1.

Para que el sistema pueda acceder al correo de forma segura, Microsoft requiere registrar una aplicación en Azure AD. Esto es el estándar actual de Microsoft (reemplaza el acceso por usuario/contraseña directa).

---

## Pasos

### 1. Entrar al portal de Azure

Ir a [https://portal.azure.com](https://portal.azure.com) e iniciar sesión con una cuenta administradora del tenant de FlexoImpresos.

---

### 2. Registrar la aplicación

1. En la barra de búsqueda superior escribir **"App registrations"** y seleccionarlo
2. Clic en **"+ New registration"**
3. Completar el formulario:
   - **Name:** `OrderLoader`
   - **Supported account types:** `Accounts in this organizational directory only (FlexoImpresos only – Single tenant)`
   - **Redirect URI:** dejar en blanco
4. Clic en **"Register"**

> Guardar el valor **"Application (client) ID"** que aparece en la pantalla — lo necesitamos.  
> Guardar también el **"Directory (tenant) ID"** — también lo necesitamos.

---

### 3. Crear un secreto de cliente

1. En el menú izquierdo de la app recién creada, ir a **"Certificates & secrets"**
2. Pestaña **"Client secrets"** → clic en **"+ New client secret"**
3. Descripción: `OrderLoader producción`
4. Expiration: **24 months** (o el máximo disponible)
5. Clic en **"Add"**

> ⚠️ **IMPORTANTE:** Copiar el valor del secreto INMEDIATAMENTE — solo se muestra una vez.  
> Guardar ese valor — lo necesitamos.

---

### 4. Asignar permisos de correo

1. En el menú izquierdo, ir a **"API permissions"**
2. Clic en **"+ Add a permission"**
3. Seleccionar **"Microsoft Graph"**
4. Seleccionar **"Delegated permissions"**
5. Buscar y marcar los siguientes permisos:
   - `Mail.Read`
   - `Mail.ReadWrite`
   - `Mail.Send`
6. Clic en **"Add permissions"**
7. Clic en **"Grant admin consent for FlexoImpresos"** → confirmar con **"Yes"**

> El botón de "Grant admin consent" requiere ser Global Administrator o Application Administrator.  
> Luego de hacer clic, los permisos deben mostrar un ✓ verde en la columna "Status".

---

### 5. Enviarnos los 3 valores

Una vez completado, enviar los siguientes datos a través del canal seguro acordado:

```
Application (client) ID:  xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
Directory (tenant) ID:    xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
Client Secret Value:      xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## ¿Qué hace el sistema con estos accesos?

El sistema `OrderLoader` usará estas credenciales **únicamente** para:

- ✅ Leer correos del buzón `Pedidos@flexoimpresos.com`
- ✅ Mover correos procesados a subcarpetas del mismo buzón
- ✅ Marcar correos como leídos

El sistema **nunca** enviará correos desde este buzón, no accede a otros buzones, no modifica contactos ni calendarios.

---

## Verificación (opcional)

Para confirmar que los permisos quedaron correctos, en "API permissions" deben verse así:

| API | Permiso | Tipo | Estado |
|-----|---------|------|--------|
| Microsoft Graph | Mail.Read | Delegated | ✓ Granted |
| Microsoft Graph | Mail.ReadWrite | Delegated | ✓ Granted |
| Microsoft Graph | Mail.Send | Delegated | ✓ Granted |

---

*Cualquier duda, contactar a Mariano García — mgarciap333@gmail.com*
