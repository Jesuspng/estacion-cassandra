// Estacion UTHH · ver como guarda Cassandra los datos en disco.
const { execFile } = require("child_process");

const CONTENEDOR = "cassandra";
const KS = "estacion";
const DATOS = "/var/lib/cassandra/data/" + KS;
const TABLAS = ["sensores", "lecturas_por_sensor_dia", "ultima_lectura",
  "alertas_por_dia", "conteo_por_dia"];

const MAX_PARTICIONES = 30;
const MAX_FILAS = 15;

function docker(comando, bitacora) {
  bitacora.push("docker exec cassandra sh -c \"" + comando + "\"");
  return new Promise((ok, falla) => {
    const args = ["exec", CONTENEDOR, "sh", "-c", comando];
    const opciones = { maxBuffer: 128 * 1024 * 1024 };
    execFile("docker", args, opciones, (e, salida, errores) => {
      if (e) return falla(new Error((errores || e.message).trim()));
      ok(salida);
    });
  });
}

function validarTabla(tabla) {
  if (!TABLAS.includes(tabla)) throw new Error("Tabla no valida: " + tabla);
  return tabla;
}

async function archivos(tabla, bitacora) {
  validarTabla(tabla);
  const patron = DATOS + "/" + tabla + "-*/*-Data.db";
  const salida = await docker(
    "stat -c '%n|%s|%Y' " + patron + " 2>/dev/null || true", bitacora);
  const lista = [];
  for (const linea of salida.trim().split("\n")) {
    if (!linea) continue;
    const [ruta, bytes, segundos] = linea.split("|");
    lista.push({
      ruta,
      nombre: ruta.split("/").pop(),
      bytes: Number(bytes),
      fecha: new Date(Number(segundos) * 1000).toISOString(),
    });
  }
  lista.sort((a, b) => b.fecha.localeCompare(a.fecha));
  return lista;
}

let herramienta = "";
async function buscarSstabledump(bitacora) {
  if (herramienta) return herramienta;
  const salida = await docker(
    "ls /opt/cassandra/tools/bin/sstabledump 2>/dev/null"
    + " || command -v sstabledump || true", bitacora);
  herramienta = salida.trim().split("\n")[0];
  if (!herramienta) {
    throw new Error("No se encontro sstabledump en el contenedor");
  }
  return herramienta;
}

async function abrir(tabla, ruta, bitacora) {
  validarTabla(tabla);
  const valida = new RegExp("^" + DATOS + "/" + tabla
    + "-[0-9a-f]+/[A-Za-z0-9_.-]+-Data\\.db$");
  if (!valida.test(ruta || "")) throw new Error("Archivo no valido");
  const sstabledump = await buscarSstabledump(bitacora);
  const salida = await docker(sstabledump + " " + ruta, bitacora);
  const inicio = salida.indexOf("[");
  if (inicio < 0) throw new Error("sstabledump no devolvio JSON");
  const particiones = JSON.parse(salida.slice(inicio));

  let filas = 0;
  let celdas = 0;
  for (const p of particiones) {
    for (const f of p.rows || []) {
      filas++;
      celdas += (f.cells || []).length;
    }
  }

  const muestra = particiones.slice(0, MAX_PARTICIONES).map(p => ({
    ...p,
    rows: (p.rows || []).slice(0, MAX_FILAS),
    totalFilas: (p.rows || []).length,
  }));
  return {
    totales: { particiones: particiones.length, filas, celdas },
    muestra,
  };
}

async function leerCuerpo(req) {
  let cuerpo = "";
  for await (const parte of req) cuerpo += parte;
  return JSON.parse(cuerpo || "{}");
}

async function ruta(req, ruta, q) {
  const comandos = [];
  const get = req.method === "GET";
  const post = req.method === "POST";

  if (get && ruta === "/api/almacen/archivos") {
    const tabla = q.get("tabla");
    const lista = await archivos(tabla, comandos);
    return { tabla, archivos: lista, comandos };
  }

  if (get && ruta === "/api/almacen/abrir") {
    const tabla = q.get("tabla");
    const datos = await abrir(tabla, q.get("archivo"), comandos);
    return { tabla, ...datos, comandos };
  }

  const accion = ruta.split("/").pop();
  if (post && (accion === "flush" || accion === "compact")) {
    const tabla = validarTabla((await leerCuerpo(req)).tabla);
    await docker("nodetool " + accion + " " + KS + " " + tabla, comandos);
    const lista = await archivos(tabla, comandos);
    return { tabla, archivos: lista, comandos };
  }

  return null;
}

module.exports = { ruta };
