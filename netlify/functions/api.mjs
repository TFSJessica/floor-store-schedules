import { getStore } from "@netlify/blobs";

/*
 * Store Schedules API for The Floor Store.
 *   GET  /api  -> { stores, ov, pto, pinRequired }
 *   POST /api  -> { action, args:[pin, ...] }  actions: checkPin, saveStore, setChange, addPto, updatePto, importPto, deletePto
 * Data lives in Netlify Blobs (store "floor-store-schedules"), keys: stores, changes, pto.
 * Set MANAGER_PIN in Netlify > Site configuration > Environment variables to require a PIN for edits.
 */

export const config = { path: "/api" };

const STORE_NAME = "floor-store-schedules";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const str = (v, max = 120) => String(v ?? "").trim().slice(0, max);
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const managerPin = () => str(process.env.MANAGER_PIN || "", 64);

async function load(store) {
  let stores = await store.get("stores", { type: "json" });
  if (!Array.isArray(stores)) {
    stores = SEED;
    await store.setJSON("stores", stores);
  }
  const ov = (await store.get("changes", { type: "json" })) || {};
  const pto = (await store.get("pto", { type: "json" })) || [];
  return { stores, ov, pto };
}

export default async (req) => {
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const pin = managerPin();

  if (req.method === "GET") {
    const d = await load(store);
    return json({ ...d, pinRequired: !!pin });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const action = str(body && body.action, 40);
  const args = Array.isArray(body && body.args) ? body.args : [];
  const given = str(args[0], 64);

  if (action === "checkPin") return json(!pin || given === pin);
  if (pin && given !== pin) return json({ error: "PIN" }, 403);

  const d = await load(store);

  switch (action) {
    case "saveStore": {
      const s = args[1] || {};
      const name = str(s.name, 60);
      if (!name) return json({ error: "Store name required" }, 400);
      const id = str(s.id, 60) || slug(name);
      const used = new Set();
      const employees = (Array.isArray(s.employees) ? s.employees : []).slice(0, 200)
        .map((e) => ({ name: str(e && e.name, 60), id: str(e && e.id, 60), days: Array.isArray(e && e.days) ? e.days : [] }))
        .filter((e) => e.name)
        .map((e) => {
          let eid = e.id || slug(e.name), base = eid, n = 2;
          while (used.has(eid)) eid = base + "-" + n++;
          used.add(eid);
          const days = e.days.slice(0, 7).map((x) => str(x, 40));
          while (days.length < 7) days.push("");
          return { id: eid, name: e.name, days };
        });
      const i = d.stores.findIndex((x) => x.id === id);
      const order = i >= 0 ? d.stores[i].order : Math.max(0, ...d.stores.map((x) => x.order || 0)) + 1;
      const rec = { id, name, order, employees };
      if (i >= 0) d.stores[i] = rec; else d.stores.push(rec);
      await store.setJSON("stores", d.stores);
      break;
    }
    case "setChange": {
      const [, sid, eid, date, val] = args;
      if (!isDate(str(date))) return json({ error: "Bad date" }, 400);
      const key = str(sid, 60) + "|" + str(eid, 60) + "|" + str(date);
      const v = val == null ? "" : str(val, 40);
      if (v) d.ov[key] = v; else delete d.ov[key];
      await store.setJSON("changes", d.ov);
      break;
    }
    case "addPto":
    case "updatePto": {
      const p = args[1] || {};
      let start = str(p.start, 10), end = str(p.end, 10) || start;
      const returnDate = str(p.returnDate, 10);
      if (!isDate(start) || !isDate(end) || (returnDate && !isDate(returnDate))) return json({ error: "Bad dates" }, 400);
      if (end < start) [start, end] = [end, start];
      const fields = { start, end, returnDate, type: str(p.type, 40), note: str(p.note, 200) };
      if (action === "addPto") {
        d.pto.push({
          id: str(p.id, 40) || Math.random().toString(36).slice(2, 12),
          storeId: str(p.storeId, 60), empId: str(p.empId, 60), name: str(p.name, 60),
          ...fields, createdAt: new Date().toISOString(),
        });
      } else {
        const i = d.pto.findIndex((x) => x.id === str(p.id, 40));
        if (i < 0) return json({ error: "Not found" }, 404);
        d.pto[i] = { ...d.pto[i], ...fields, updatedAt: new Date().toISOString() };
      }
      await store.setJSON("pto", d.pto);
      break;
    }
    case "importPto": {
      const list = Array.isArray(args[1]) ? args[1].slice(0, 500) : [];
      const key = (x) => [x.storeId, x.empId, x.start, x.end, x.type].join("|");
      const have = new Set(d.pto.map(key));
      let added = 0;
      for (const p of list) {
        let start = str(p && p.start, 10), end = str(p && p.end, 10) || start;
        const returnDate = str(p && p.returnDate, 10);
        if (!isDate(start) || !isDate(end) || (returnDate && !isDate(returnDate))) continue;
        if (end < start) [start, end] = [end, start];
        const rec = {
          id: str(p.id, 40) || Math.random().toString(36).slice(2, 12),
          storeId: str(p.storeId, 60), empId: str(p.empId, 60), name: str(p.name, 60),
          start, end, returnDate, type: str(p.type, 40), note: str(p.note, 200), createdAt: new Date().toISOString(),
        };
        if (!rec.storeId || !rec.empId || have.has(key(rec))) continue;
        have.add(key(rec));
        d.pto.push(rec);
        added++;
      }
      if (added) await store.setJSON("pto", d.pto);
      break;
    }
    case "deletePto": {
      const id = str(args[1], 40);
      d.pto = d.pto.filter((p) => p.id !== id);
      await store.setJSON("pto", d.pto);
      break;
    }
    default:
      return json({ error: "Unknown action" }, 400);
  }
  return json({ ...d, pinRequired: !!pin });
};

/* Starting schedules, from "Full Store Schedule" in Canva. Used only the first time the site runs. */
const SEED = [{"id": "richmond", "name": "Richmond", "order": 1, "employees": [{"id": "katherine", "name": "Katherine", "days": ["9AM - 6PM", "10AM - 7PM", "10AM - 7PM", "10AM - 7PM", "OFF", "9AM - 5:30PM", "OFF"]}, {"id": "gio", "name": "Gio", "days": ["10AM - 7PM", "OFF", "OFF", "10AM - 7PM", "10AM - 7PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "brian", "name": "Brian", "days": ["OFF", "9AM - 6PM", "9AM - 6PM", "9AM - 6PM", "9AM - 5PM", "9AM - 5:30PM", "OFF"]}, {"id": "chris", "name": "Chris", "days": ["10AM - 7PM", "10AM - 7PM", "10AM - 7PM", "OFF", "OFF", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "rick", "name": "Rick", "days": ["OFF", "9AM - 6PM", "9AM - 6PM", "9AM - 6PM", "9AM - 6PM", "9AM - 5:30PM", "OFF"]}]}, {"id": "concord", "name": "Concord", "order": 2, "employees": [{"id": "julie", "name": "Julie", "days": ["9AM - 3:30PM", "9AM - 3:30PM", "OFF", "OFF", "9AM - 3:30PM", "9AM - 3:30PM", "OFF"]}, {"id": "tiffany", "name": "Tiffany", "days": ["10AM - 7PM", "10AM - 7PM", "10AM - 7PM", "OFF", "OFF", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "daniel", "name": "Daniel", "days": ["10AM - 7PM", "OFF", "OFF", "10AM - 7PM", "10AM - 7PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "willie", "name": "Willie", "days": ["10AM - 7PM", "10AM - 7PM", "9AM - 6PM", "10AM - 7PM", "OFF", "OFF", "11AM - 5:30PM"]}, {"id": "jake", "name": "Jake", "days": ["OFF", "10AM - 7PM", "10AM - 7PM", "9AM - 6PM", "10AM - 7PM", "9AM - 5:30PM", "OFF"]}, {"id": "zonia", "name": "Zonia", "days": ["9AM - 6PM", "9AM - 6PM", "9AM - 6PM", "9AM - 6PM", "OFF", "OFF", "11AM - 5:30PM"]}]}, {"id": "dublin", "name": "Dublin", "order": 3, "employees": [{"id": "teza", "name": "Teza", "days": ["9AM - 6PM", "OFF", "OFF", "9AM - 6PM", "9AM - 6PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "carlos", "name": "Carlos", "days": ["OFF", "10AM - 7PM", "10AM - 7PM", "10AM - 7PM", "10AM - 7PM", "9AM - 5:30PM", "OFF"]}, {"id": "meli", "name": "Meli", "days": ["10AM - 7PM", "10AM - 7PM", "10AM - 7PM", "OFF", "OFF", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "david", "name": "David", "days": ["10AM - 7PM", "10AM - 7PM", "10AM - 7PM", "OFF", "OFF", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "will", "name": "Will", "days": ["10AM - 7PM", "10AM - 7PM", "10AM - 7PM", "10AM - 7PM", "OFF", "OFF", "11AM - 5:30PM"]}, {"id": "ryan", "name": "Ryan", "days": ["OFF", "OFF", "9AM - 6PM", "9AM - 6PM", "9AM - 6PM", "9AM - 5:30PM", "11AM - 5:30PM"]}]}, {"id": "san-francisco", "name": "San Francisco", "order": 4, "employees": [{"id": "rose-fernandez", "name": "Rose Fernandez", "days": ["8:30AM - 5PM", "8:30AM - 5PM", "8:30AM - 5PM", "10AM - 7PM", "OFF", "OFF", "11AM - 5:30PM"]}, {"id": "tj-oakley", "name": "TJ Oakley", "days": ["OFF", "10AM - 7PM", "10AM - 7PM", "9AM - 6PM", "9AM - 6PM", "9AM - 5:30PM", "OFF"]}, {"id": "rodney-haynes", "name": "Rodney Haynes", "days": ["11AM - 7PM", "OFF", "OFF", "11AM - 7PM", "11AM - 7PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "david-maciel", "name": "David Maciel", "days": ["9AM - 6PM", "10AM - 7PM", "9AM - 5PM", "OFF", "OFF", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "felix-medina", "name": "Felix Medina", "days": ["9AM - 6PM", "COMMERCIAL DAY", "9AM - 6PM", "COMMERCIAL DAY", "9AM - 6PM", "OFF", "OFF"]}]}, {"id": "santa-rosa", "name": "Santa Rosa", "order": 5, "employees": [{"id": "damian", "name": "Damian", "days": ["OFF", "9AM - 6PM", "8AM - 6PM", "9AM - 7PM", "9AM - 6PM", "9AM - 5:30PM", "OFF"]}, {"id": "bob", "name": "Bob", "days": ["9AM - 6PM", "9AM - 6PM", "OFF", "OFF", "9AM - 6PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "tim", "name": "Tim", "days": ["FMLA", "FMLA", "FMLA", "FMLA", "FMLA", "FMLA", "FMLA"]}, {"id": "mark", "name": "Mark", "days": ["9AM - 6PM", "9AM - 3PM", "10AM - 7PM", "OFF", "OFF", "OFF", "OFF"]}, {"id": "alan", "name": "Alan", "days": ["10AM - 7PM", "OFF", "OFF", "9AM - 6PM", "10AM - 7PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "robert", "name": "Robert", "days": ["FMLA", "FMLA", "FMLA", "FMLA", "FMLA", "FMLA", "FMLA"]}, {"id": "tom", "name": "Tom", "days": ["9AM - 3PM", "9AM - 3PM", "9AM - 3PM", "9AM - 3PM", "OFF", "OFF", "11AM - 5:30PM"]}, {"id": "matt", "name": "Matt", "days": ["OFF", "OFF", "9AM - 6PM", "9AM - 6PM", "9AM - 6PM", "9AM - 5:30PM", "11AM - 5:30PM"]}]}, {"id": "marin", "name": "Marin", "order": 6, "employees": [{"id": "xavier", "name": "Xavier", "days": ["OFF", "9AM - 5PM", "9AM - 5PM", "9AM - 5PM", "9AM - 5PM", "9AM - 5:30PM", "OFF"]}, {"id": "david", "name": "David", "days": ["9AM - 5PM", "OFF", "OFF", "10AM - 6PM", "10AM - 6PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "luis", "name": "Luis", "days": ["OPEN", "OFF", "OFF", "10AM - 6PM", "10AM - 6PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "michael", "name": "Michael", "days": ["10AM - 6PM", "10AM - 6PM", "9AM - 5PM", "OFF", "OFF", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "josh", "name": "Josh", "days": ["10AM - 6PM", "9AM - 5PM", "10AM - 6PM", "OPEN", "OFF", "OFF", "11AM - 5:30PM"]}]}, {"id": "san-carlos", "name": "San Carlos", "order": 7, "employees": [{"id": "laurie-d", "name": "Laurie D", "days": ["10AM - 7PM", "10AM - 7PM", "OFF", "OFF", "10AM - 7PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "keith-g", "name": "Keith G", "days": ["10AM - 7PM", "OFF", "OFF", "10AM - 7PM", "10AM - 7PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "gordon-t", "name": "Gordon T", "days": ["9AM - 6PM", "9AM - 6PM", "9AM - 6PM", "OFF", "OFF", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "ben-m", "name": "Ben M", "days": ["OFF", "10AM - 7PM", "10AM - 7PM", "9AM - 6PM", "9AM - 6PM", "9AM - 5:30PM", "OFF"]}, {"id": "sherif-a", "name": "Sherif A", "days": ["10AM - 7PM", "10AM - 7PM", "OFF", "10AM - 7PM", "10AM - 7PM", "9AM - 5:30PM", "OFF"]}, {"id": "gabe-e", "name": "Gabe E", "days": ["", "OFF", "", "", "", "", "OFF"]}]}, {"id": "sunnyvale", "name": "Sunnyvale", "order": 8, "employees": [{"id": "diana", "name": "Diana", "days": ["10AM - 7PM", "10AM - 7PM", "OFF", "OFF", "10AM - 7PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "avery", "name": "Avery", "days": ["OFF", "9AM - 6PM", "9AM - 6PM", "9AM - 6PM", "9AM - 6PM", "9AM - 5:30PM", "OFF"]}]}, {"id": "san-jose", "name": "San Jose", "order": 9, "employees": [{"id": "gabby", "name": "Gabby", "days": ["9AM - 6PM", "9AM - 6PM", "9AM - 6PM", "9AM - 6PM", "OFF", "9AM - 5:30PM", "OFF"]}, {"id": "patti", "name": "Patti", "days": ["9AM - 6PM", "OFF", "9AM - 6PM", "10AM - 7PM", "9AM - 6PM", "OFF", "11AM - 5:30PM"]}, {"id": "genesis", "name": "Genesis", "days": ["10AM - 7PM", "10AM - 7PM", "OFF", "OFF", "10AM - 7PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "eva", "name": "Eva", "days": ["10AM - 7PM", "10AM - 7PM", "10AM - 7PM", "OFF", "OFF", "9AM - 5:30PM", "11AM - 5:30PM"]}]}, {"id": "burlingame", "name": "Burlingame", "order": 10, "employees": [{"id": "steve", "name": "Steve", "days": ["OFF", "9AM - 5:30PM", "9AM - 5:30PM", "9AM - 5:30PM", "9AM - 5:30PM", "9AM - 5PM", "CLOSED"]}, {"id": "iris", "name": "Iris", "days": ["OFF", "9AM - 5:30PM", "9AM - 5:30PM", "9AM - 5:30PM", "9AM - 5:30PM", "9AM - 5PM", "CLOSED"]}]}, {"id": "fairfield", "name": "Fairfield", "order": 11, "employees": [{"id": "danny-fox-pt", "name": "Danny Fox (PT)", "days": ["9AM - 5PM", "9AM - 5PM", "9AM - 5PM", "OFF", "OFF", "OFF", "11AM - 5:30PM"]}, {"id": "alex-cruz", "name": "Alex Cruz", "days": ["OFF", "9AM - 6PM", "10AM - 7PM", "10AM - 7PM", "9AM - 6PM", "9AM - 5:30PM", "OFF"]}, {"id": "curtis-lett", "name": "Curtis Lett", "days": ["9AM - 6PM", "OFF", "OFF", "9AM - 6PM", "9AM - 6PM", "9AM - 5:30PM", "11AM - 5:30PM"]}, {"id": "reginald-brown", "name": "Reginald Brown", "days": ["10AM - 7PM", "10AM - 7PM", "OFF", "OFF", "10AM - 7PM", "9AM - 5:30PM", "11AM - 5:30PM"]}]}];
