import { useCallback, useEffect, useMemo, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, type BoardItem } from "../api";
import { dateIt, daysLeft, euro, num, pct, truncate } from "../lib/format";
import { Badge, Empty, Modal, Spinner } from "../components/ui";
import { IconDownload, IconTrash } from "../components/icons";

const COLUMNS: { id: string; label: string; accent: string }[] = [
  { id: "valutare", label: "Da valutare", accent: "bg-slate-400" },
  { id: "preparare", label: "In preparazione", accent: "bg-sky-500" },
  { id: "presentato", label: "Presentato", accent: "bg-amber-500" },
  { id: "vinto", label: "Vinto", accent: "bg-emerald-500" },
  { id: "perso", label: "Perso", accent: "bg-rose-500" },
];

export default function BoardPage({
  onOpen,
  notify,
  onStatsChanged,
}: {
  onOpen: (id: string) => void;
  notify: (message: string, tone?: "info" | "error") => void;
  onStatsChanged: () => void;
}) {
  const [items, setItems] = useState<BoardItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [mode, setMode] = useState<"kanban" | "calendario">("kanban");
  const [month, setMonth] = useState(() => new Date());
  const [noteFor, setNoteFor] = useState<BoardItem | null>(null);
  const [noteText, setNoteText] = useState("");

  const load = useCallback(async () => {
    try {
      setItems(await api.boardList());
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const move = async (noticeId: string, column: string) => {
    const target = items.filter((item) => item.columnKey === column).length;
    setItems((previous) =>
      previous.map((item) =>
        item.notice.id === noticeId ? { ...item, columnKey: column, position: target } : item,
      ),
    );
    try {
      await api.boardUpdate(noticeId, { column, position: target });
      onStatsChanged();
    } catch (error) {
      notify(String(error), "error");
      void load();
    }
  };

  const remove = async (noticeId: string) => {
    setItems((previous) => previous.filter((item) => item.notice.id !== noticeId));
    try {
      await api.boardRemove(noticeId);
      onStatsChanged();
    } catch (error) {
      notify(String(error), "error");
      void load();
    }
  };

  const saveNote = async () => {
    if (!noteFor) return;
    try {
      await api.boardUpdate(noteFor.notice.id, { note: noteText });
      setItems((previous) =>
        previous.map((item) =>
          item.notice.id === noteFor.notice.id ? { ...item, note: noteText || null } : item,
        ),
      );
      setNoteFor(null);
    } catch (error) {
      notify(String(error), "error");
    }
  };

  const exportBoard = async () => {
    setExporting(true);
    try {
      const path = await api.exportBoard();
      notify(`Bacheca esportata: ${path}`);
      await revealItemInDir(path);
    } catch (error) {
      notify(String(error), "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-white px-6 py-2.5">
        <div
          className="flex rounded border border-slate-300 bg-slate-50 p-0.5"
          role="group"
          aria-label="Vista della bacheca"
        >
          {(["kanban", "calendario"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setMode(value)}
              aria-pressed={mode === value}
              className={`rounded px-2.5 py-1 text-[11px] capitalize transition-colors ${
                mode === value
                  ? "bg-white font-medium text-cyan-900 shadow-sm ring-1 ring-slate-300"
                  : "text-slate-600 hover:bg-slate-100 hover:text-heading"
              }`}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500">
            {num(items.length)} {items.length === 1 ? "gara" : "gare"}
          </span>
          <button
            className="btn px-3 py-1.5 text-[12px]"
            onClick={exportBoard}
            disabled={exporting || items.length === 0}
          >
            <IconDownload /> {exporting ? "Esporto…" : "Excel"}
          </button>
        </div>
      </header>

      {loading ? (
        <div className="p-7">
          <Spinner label="Carico la bacheca…" />
        </div>
      ) : items.length === 0 ? (
        <div className="p-7">
          <Empty
            title="La bacheca è vuota"
            hint="Dalla ricerca, aggiungi una gara con il pulsante +. Da qui la segui fino all'esito."
          />
        </div>
      ) : mode === "calendario" ? (
        <Calendar items={items} month={month} onChangeMonth={setMonth} onOpen={onOpen} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-5 gap-2.5 overflow-x-auto bg-page p-4">
          {COLUMNS.map((column) => {
            const columnItems = items
              .filter((item) => item.columnKey === column.id)
              .sort((a, b) => a.position - b.position);
            const total = columnItems.reduce(
              (sum, item) => sum + (item.notice.estimatedValue ?? 0),
              0,
            );
            return (
              <div
                key={column.id}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (dragging) void move(dragging, column.id);
                  setDragging(null);
                }}
                className={`flex min-w-[200px] flex-col rounded-lg border border-line bg-slate-50 ${
                  dragging ? "border-dashed border-cyan-400" : ""
                }`}
              >
                <div className="flex items-center justify-between px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${column.accent}`} />
                    <span className="text-[11.5px] font-semibold text-copy">{column.label}</span>
                  </div>
                  <span className="text-[10.5px] tabular text-slate-500">
                    {columnItems.length}
                  </span>
                </div>
                <div className="px-3 pb-1 text-[10px] tabular text-slate-500">{euro(total)}</div>

                <div className="flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
                  {columnItems.map((item) => {
                    const remaining = daysLeft(item.notice.deadlineAt);
                    return (
                      <div
                        key={item.notice.id}
                        draggable
                        onDragStart={() => setDragging(item.notice.id)}
                        onDragEnd={() => setDragging(null)}
                        onClick={() => onOpen(item.notice.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          // Solo se il fuoco è sulla scheda: i pulsanti interni
                          // (nota, rimuovi) gestiscono già i propri tasti.
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onOpen(item.notice.id);
                          }
                        }}
                        aria-label={`Apri la gara ${item.notice.title}`}
                        className={`group cursor-grab rounded-lg border border-line bg-white px-2.5 py-2 shadow-sm transition-colors hover:border-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700/40 ${
                          dragging === item.notice.id ? "opacity-40" : ""
                        }`}
                      >
                        <div className="line-clamp-3 text-[11.5px] font-medium leading-snug text-copy">
                          {item.notice.title}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <Badge tone={item.notice.source === "anac" ? "amber" : "blue"}>
                            {item.notice.source === "anac" ? "ANAC" : "TED"}
                          </Badge>
                          {item.notice.pnrr && <Badge tone="green">PNRR</Badge>}
                          {item.notice.cig && (
                            <span className="font-mono text-[9px] text-slate-500">
                              {item.notice.cig}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 truncate text-[10px] text-slate-500">
                          {item.notice.buyerName ?? "—"}
                        </div>
                        <div className="mt-1.5 flex items-center justify-between text-[10px]">
                          <span className="tabular text-slate-500">
                            {euro(item.notice.estimatedValue)}
                          </span>
                          {item.notice.discountPct !== null && (
                            <span className="tabular text-emerald-700">
                              {pct(item.notice.discountPct)}
                            </span>
                          )}
                        </div>
                        {item.notice.deadlineAt && (
                          <div
                            className={`mt-1 text-[9.5px] ${
                              remaining !== null && remaining >= 0 && remaining <= 7
                                ? "text-rose-700"
                                : "text-slate-500"
                            }`}
                          >
                            {remaining !== null && remaining < 0
                              ? "scaduto"
                              : `${dateIt(item.notice.deadlineAt)} · ${remaining}g`}
                          </div>
                        )}
                        {item.note && (
                          <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-1.5 py-1 text-[10px] leading-snug text-amber-900">
                            {truncate(item.note, 120)}
                          </div>
                        )}
                        <div className="mt-1.5 flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                          {/* Il trascinamento non è usabile da tastiera: questo
                              selettore è la via equivalente. */}
                          <select
                            className="rounded border border-line bg-white px-1 py-0.5 text-[10px] text-slate-600"
                            value={item.columnKey}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                            onChange={(event) => void move(item.notice.id, event.target.value)}
                            aria-label={`Sposta «${item.notice.title}» in un'altra colonna`}
                          >
                            {COLUMNS.map((column) => (
                              <option key={column.id} value={column.id}>
                                {column.label}
                              </option>
                            ))}
                          </select>
                          <button
                            className="rounded px-1 text-[10px] text-slate-500 hover:bg-slate-100 hover:text-heading"
                            onClick={(event) => {
                              event.stopPropagation();
                              setNoteFor(item);
                              setNoteText(item.note ?? "");
                            }}
                          >
                            nota
                          </button>
                          <button
                            className="rounded px-1 text-slate-500 hover:bg-rose-50 hover:text-rose-700"
                            onClick={(event) => {
                              event.stopPropagation();
                              void remove(item.notice.id);
                            }}
                            aria-label={`Rimuovi dalla bacheca: ${item.notice.title}`}
                          >
                            <IconTrash size={11} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {columnItems.length === 0 && (
                    <div className="rounded-lg border border-dashed border-slate-300 px-2 py-6 text-center text-[10px] text-slate-500">
                      trascina qui
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal open={Boolean(noteFor)} onClose={() => setNoteFor(null)} title="Nota sulla gara">
        <textarea
          className="input h-32 resize-none"
          value={noteText}
          onChange={(event) => setNoteText(event.target.value)}
          placeholder="es. chiedere la cauzione, socio referente per il lotto 2…"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button className="btn" onClick={() => setNoteFor(null)}>
            Annulla
          </button>
          <button className="btn btn-primary" onClick={saveNote}>
            Salva nota
          </button>
        </div>
      </Modal>
    </div>
  );
}

const MONTHS = [
  "gennaio",
  "febbraio",
  "marzo",
  "aprile",
  "maggio",
  "giugno",
  "luglio",
  "agosto",
  "settembre",
  "ottobre",
  "novembre",
  "dicembre",
];

function Calendar({
  items,
  month,
  onChangeMonth,
  onOpen,
}: {
  items: BoardItem[];
  month: Date;
  onChangeMonth: (date: Date) => void;
  onOpen: (id: string) => void;
}) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const today = new Date();

  const byDay = useMemo(() => {
    const map = new Map<number, BoardItem[]>();
    for (const item of items) {
      if (!item.notice.deadlineAt) continue;
      const date = new Date(item.notice.deadlineAt);
      if (date.getFullYear() !== year || date.getMonth() !== monthIndex) continue;
      const day = date.getDate();
      map.set(day, [...(map.get(day) ?? []), item]);
    }
    return map;
  }, [items, year, monthIndex]);

  const startOffset = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: startOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
  const dueThisMonth = [...byDay.values()].reduce((sum, list) => sum + list.length, 0);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[14px] font-medium capitalize text-copy">
          {MONTHS[monthIndex]} {year}
          <span className="ml-2 text-[11px] font-normal text-slate-500">
            {dueThisMonth} scadenze in bacheca
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            className="btn px-2 py-1 text-[11px]"
            onClick={() => onChangeMonth(new Date(year, monthIndex - 1, 1))}
          >
            ←
          </button>
          <button
            className="btn px-2 py-1 text-[11px]"
            onClick={() => onChangeMonth(new Date())}
          >
            Oggi
          </button>
          <button
            className="btn px-2 py-1 text-[11px]"
            onClick={() => onChangeMonth(new Date(year, monthIndex + 1, 1))}
          >
            →
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {["lun", "mar", "mer", "gio", "ven", "sab", "dom"].map((day) => (
          <div
            key={day}
            className="pb-1 text-center text-[10px] uppercase tracking-[0.14em] text-slate-500"
          >
            {day}
          </div>
        ))}
        {cells.map((day, index) => {
          const list = day ? (byDay.get(day) ?? []) : [];
          const isToday =
            day !== null &&
            today.getFullYear() === year &&
            today.getMonth() === monthIndex &&
            today.getDate() === day;
          return (
            <div
              key={index}
              className={`min-h-[92px] rounded-lg border p-1.5 ${
                day === null
                  ? "border-transparent"
                  : isToday
                    ? "border-amber-400 bg-amber-50"
                    : "border-line bg-white"
              }`}
            >
              {day !== null && (
                <>
                  <div
                    className={`mb-1 text-[10px] tabular ${
                      isToday ? "font-semibold text-amber-800" : "text-slate-500"
                    }`}
                  >
                    {day}
                  </div>
                  <div className="space-y-0.5">
                    {list.slice(0, 3).map((item) => {
                      const column = COLUMNS.find((entry) => entry.id === item.columnKey);
                      return (
                        <button
                          key={item.notice.id}
                          onClick={() => onOpen(item.notice.id)}
                          className="flex w-full items-start gap-1 rounded bg-slate-50 px-1 py-0.5 text-left text-[9.5px] leading-tight text-copy hover:bg-slate-100"
                          title={item.notice.title}
                        >
                          <span
                            className={`mt-0.5 h-1 w-1 shrink-0 rounded-full ${
                              column?.accent ?? "bg-slate-400"
                            }`}
                          />
                          <span className="line-clamp-2">{truncate(item.notice.title, 48)}</span>
                        </button>
                      );
                    })}
                    {list.length > 3 && (
                      <div className="px-1 text-[9px] text-slate-500">+{list.length - 3}</div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
