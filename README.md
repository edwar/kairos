# kairos

Buscador minimalista de ofertas de empleo. Sin servicios de pago: lee directamente los portales públicos y APIs abiertas.

| Fuente | Países | Cómo |
|---|---|---|
| Computrabajo | MX, CO, AR, CL, PE | scraping de su listado público |
| Elempleo | CO | scraping de su listado público |
| Get on Board | MX, CO, AR, CL, PE | API pública |
| RemoteOK | Remoto global | API pública |
| Jobicy | Remoto global | API pública |

```bash
cp .env.example .env   # opcional: GROQ_API_KEY para IA (enriquecimiento, CV y carta)
pnpm i && pnpm dev
```

- **Filtros que relanzan la búsqueda:** texto, países, antigüedad.
- **Filtros instantáneos (sobre lo ya cargado):** modalidad, contrato, idioma, nivel, stack, con sueldo, red flags, texto.
- Los resultados se cachean en disco (`.cache/search`, `CACHE_TTL_MIN` minutos) para no repetir peticiones a los portales.
- Si un portal activa un captcha, esa fuente devuelve un error y se deja de consultar 15 minutos.
- Con `GROQ_API_KEY`: rellena campos que las reglas no detectan y permite adaptar tu CV (PDF) y generar una carta de presentación por oferta, sin inventar datos que no estén en tu CV.
