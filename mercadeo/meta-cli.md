Ads CLI de Meta — Documento Técnico Oficial
Basado en la documentación oficial de Meta Ads CLI actualizada al 29 abril 2026.

1. Introducción
Ads CLI es una herramienta de línea de comandos desarrollada por Meta para administrar publicidad programáticamente usando la Meta Marketing API.
Permite:
·	Crear campañas publicitarias
·	Administrar Ad Sets
·	Crear anuncios
·	Gestionar creativos
·	Consultar insights
·	Manejar Pixels/Datasets
·	Gestionar catálogos de productos
·	Automatizar flujos publicitarios
Sintaxis principal:
meta ads <resource> <action> [options]


2. Casos de Uso
Ads CLI está orientado a:
·	Integraciones programáticas
·	Automatización CI/CD
·	Agentes IA
·	Operaciones de growth
·	Pipelines backend
·	Testing rápido de Marketing API

3. Instalación
Requisitos
·	Python 3.12+
·	pip
·	uv
·	Virtual Environment
·	Access Token Meta
·	Ad Account
Instalar paquete
pip install meta-ads

Inicializar entorno
uv sync

Ejecutar CLI
uv run meta


4. Autenticación
Ads CLI utiliza:
·	System User Access Token
No usa OAuth interactivo tradicional.

5. Configuración del System User
Crear usuario del sistema
Ruta:
Meta Business Suite
→ Settings
→ Users
→ System Users

Configurar:
Role: Admin


6. Assets requeridos
El usuario del sistema debe tener acceso a:
·	Ad Accounts
·	Datasets / Pixels
·	Business Pages
·	Product Catalogs

7. Agregar como App Admin
Ruta:
Meta for Developers
→ App Settings
→ Roles


8. Scopes requeridos
business_management
ads_management
pages_show_list
pages_read_engagement
pages_manage_ads
catalog_management
read_insights


9. Variables de entorno
Variable	Requerida	Descripción
ACCESS_TOKEN	Sí	Token del sistema
AD_ACCOUNT_ID	Sí	Cuenta publicitaria
BUSINESS_ID	No	Business Manager


10. Archivo .env
ACCESS_TOKEN=xxx
AD_ACCOUNT_ID=act_xxx
BUSINESS_ID=xxx


11. Prioridad de Configuración
Orden de resolución:
1.	Command Flags
2.	Environment Variables
3.	.env
4.	~/.config/meta/

12. Formatos de salida
table
Formato humano.
json
Ideal para automatización.
meta --output json ads campaign list

plain
TSV para pipelines Unix.

13. Exit Codes
Código	Significado
0	Success
1	General Error
2	Usage Error
3	Authentication Error
4	API Error
5	Resource Not Found


14. Comandos Globales
Flag	Descripción
--output	table/json/plain
--no-color	Deshabilitar color
--no-input	No prompts
--debug	Debug logs
--help	Ayuda
--version	Versión


15. Ad Accounts
Listar cuentas
meta ads adaccount list

Cuenta actual
meta ads adaccount current


16. Pages
Listar páginas
meta ads page list


17. Campaigns
Crear campaña
meta ads campaign create \
  --name "Sales Campaign" \
  --objective OUTCOME_SALES \
  --daily-budget 5000

Objetivos disponibles
·	OUTCOME_TRAFFIC
·	OUTCOME_SALES
·	OUTCOME_LEADS
·	OUTCOME_ENGAGEMENT
·	OUTCOME_AWARENESS
·	OUTCOME_APP_PROMOTION

Actualizar campaña
meta ads campaign update <CAMPAIGN_ID> \
  --status ACTIVE

Estados
·	ACTIVE
·	PAUSED
·	ARCHIVED

18. Ad Sets
Crear Ad Set
meta ads adset create <CAMPAIGN_ID> \
  --name "US Audience" \
  --optimization-goal LINK_CLICKS \
  --billing-event IMPRESSIONS \
  --targeting-countries US


Conversion Tracking
meta ads adset create <CAMPAIGN_ID> \
  --optimization-goal OFFSITE_CONVERSIONS \
  --pixel-id <PIXEL_ID> \
  --custom-event-type PURCHASE


Optimization Goals
·	LINK_CLICKS
·	OFFSITE_CONVERSIONS
·	LEAD_GENERATION
·	REACH
·	VALUE
·	THRUPLAY

19. Ads
Crear anuncio
meta ads ad create <AD_SET_ID> \
  --name "My Ad" \
  --creative-id <CREATIVE_ID>


20. Ad Creatives
Link Ad
meta ads creative create \
  --name "Summer Sale" \
  --page-id <PAGE_ID> \
  --image ./banner.jpg \
  --body "50% off everything!" \
  --title "Shop Now" \
  --link-url https://example.com \
  --call-to-action SHOP_NOW


Video Ad
meta ads creative create \
  --video ./promo.mp4


Photo Post
meta ads creative create \
  --image ./photo.jpg


21. Dynamic Creative Optimization (DCO)
Crear DCO
meta ads creative create \
  --name "DCO Creative" \
  --page-id <PAGE_ID> \
  --link-url https://example.com \
  --images ./img1.jpg \
  --images ./img2.jpg \
  --titles "Title A" \
  --titles "Title B" \
  --bodies "Body A" \
  --bodies "Body B"


Límites
Asset	Máximo
Images	10
Videos	10
Titles	5
Bodies	5
Descriptions	5
CTA	5


22. Call To Actions
·	APPLY_NOW
·	BUY_NOW
·	CONTACT_US
·	DOWNLOAD
·	GET_OFFER
·	LEARN_MORE
·	SHOP_NOW
·	SIGN_UP
·	SUBSCRIBE
·	WATCH_MORE

23. Insights
Query básica
meta ads insights get


Métricas personalizadas
meta ads insights get \
  --fields spend,impressions,ctr,cpc,purchase_roas


Métricas importantes
Campo	Descripción
spend	Gasto
impressions	Impresiones
ctr	Click Through Rate
cpc	Cost Per Click
cpm	Cost Per Mille
conversions	Conversiones
purchase_roas	ROAS


24. Rangos de fechas
Presets
meta ads insights get --date-preset last_30d

Valores:
·	today
·	yesterday
·	last_3d
·	last_7d
·	last_14d
·	last_30d
·	last_90d
·	this_month
·	last_month

Fechas custom
meta ads insights get \
  --since 2024-01-01 \
  --until 2024-01-31


25. Breakdowns
Edad y género
meta ads insights get \
  --breakdown age \
  --breakdown gender


Plataformas
meta ads insights get \
  --breakdown publisher_platform


26. Sorting
meta ads insights get \
  --sort spend_descending

Formato:
<metric>_ascending
<metric>_descending


27. Datasets / Pixels
Crear Pixel
meta ads dataset create \
  --name "Website Pixel"


Conectar Pixel
meta ads dataset connect <PIXEL_ID> \
  --ad-account-id <AD_ACCOUNT_ID>


Eventos soportados
·	PURCHASE
·	LEAD
·	ADD_TO_CART
·	INITIATED_CHECKOUT
·	COMPLETE_REGISTRATION

28. Product Catalogs
Crear catálogo
meta ads catalog create \
  --name "My Catalog"


Verticales disponibles
·	commerce
·	hotels
·	vehicles
·	flights
·	home_listings
·	generic

29. Automatización
No Interactive Mode
meta --no-input ads campaign delete \
  <CAMPAIGN_ID> --force


30. JSON Automation
meta --output json ads campaign list


jq Integration
meta --output json ads campaign list \
  | jq '.[].id'


31. Full Workflow
1. Crear campaña
meta ads campaign create \
  --name "Sales"

2. Crear Ad Set
meta ads adset create <CAMPAIGN_ID>

3. Crear Creative
meta ads creative create \
  --image ./banner.jpg

4. Crear Ad
meta ads ad create <AD_SET_ID>

5. Activar
meta ads campaign update <ID> --status ACTIVE


32. Cleanup
Eliminar Ad
meta ads ad delete <AD_ID> --force

Eliminar Ad Set
meta ads adset delete <AD_SET_ID> --force

Eliminar Campaign
meta ads campaign delete <CAMPAIGN_ID> --force


33. Arquitectura Recomendada
Stack recomendado
·	Python
·	FastAPI
·	PostgreSQL
·	Redis
·	Make.com
·	n8n
·	Temporal

34. Arquitectura IA
LLM
 ↓
Decision Engine
 ↓
Ads CLI
 ↓
Meta Marketing API
 ↓
Insights
 ↓
Optimization Loop


35. Riesgos Técnicos
Rate Limits
Implementar:
·	queues
·	retries
·	exponential backoff

Tokens
Necesario:
·	token rotation
·	monitoring
·	refresh strategy

Creative Fatigue
Automatizar campañas malas escala pérdidas rápidamente.
Se requiere:
·	ranking creativo
·	testing
·	intelligence layer

36. Conclusión Técnica
Ads CLI representa la transición de Meta hacia:
·	AI-native advertising
·	programmable marketing
·	autonomous media buying
·	infrastructure-first advertising
La interfaz gráfica se vuelve secundaria.
La ventaja competitiva futura estará en:
·	sistemas autónomos
·	optimización algorítmica
·	agentes IA
·	loops automáticos de decisión
·	pipelines de growth escalables
