//! Bacheca: schede dei bandi con colonna, posizione e note.

use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

use crate::db::now_iso;
use crate::search::{attach_lots, hit_from_row, NoticeHit, HIT_COLUMNS};

pub const COLUMNS: [&str; 5] = ["valutare", "preparare", "presentato", "vinto", "perso"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardItem {
    pub notice: NoticeHit,
    pub column_key: String,
    pub position: i64,
    pub note: Option<String>,
    pub updated_at: String,
}

pub fn list(conn: &Connection) -> Result<Vec<BoardItem>> {
    let sql = format!(
        "SELECT {HIT_COLUMNS}, b.column_key, b.position, b.note, b.updated_at
         FROM board_items b JOIN notices n ON n.id = b.notice_id
         ORDER BY b.column_key, b.position, b.updated_at DESC"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut items = statement
        .query_map([], |row| {
            Ok(BoardItem {
                notice: hit_from_row(row)?,
                column_key: row.get(28)?,
                position: row.get(29)?,
                note: row.get(30)?,
                updated_at: row.get(31)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut notices: Vec<NoticeHit> = items.iter().map(|item| item.notice.clone()).collect();
    attach_lots(conn, &mut notices)?;
    for (item, notice) in items.iter_mut().zip(notices) {
        item.notice = notice;
    }
    Ok(items)
}

pub fn add(conn: &Connection, notice_id: &str, column_key: &str) -> Result<()> {
    let column = if COLUMNS.contains(&column_key) {
        column_key
    } else {
        "valutare"
    };
    let position: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM board_items WHERE column_key = ?",
        [column],
        |row| row.get(0),
    )?;
    conn.execute(
        "INSERT INTO board_items (notice_id, column_key, position, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(notice_id) DO UPDATE SET column_key = excluded.column_key,
         position = excluded.position, updated_at = excluded.updated_at",
        rusqlite::params![notice_id, column, position, now_iso()],
    )?;
    Ok(())
}

pub fn update(
    conn: &Connection,
    notice_id: &str,
    column_key: Option<&str>,
    position: Option<i64>,
    note: Option<&str>,
) -> Result<()> {
    let Some(mut current) = conn
        .query_row(
            "SELECT column_key, position, note FROM board_items WHERE notice_id = ?",
            [notice_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .ok()
    else {
        add(conn, notice_id, column_key.unwrap_or("valutare"))?;
        if note.is_some() {
            update(conn, notice_id, None, None, note)?;
        }
        return Ok(());
    };

    if let Some(column) = column_key {
        if COLUMNS.contains(&column) {
            current.0 = column.to_string();
        }
    }
    if let Some(position) = position {
        current.1 = position;
    }
    if let Some(note) = note {
        current.2 = if note.trim().is_empty() {
            None
        } else {
            Some(note.to_string())
        };
    }

    conn.execute(
        "UPDATE board_items SET column_key = ?, position = ?, note = ?, updated_at = ? \
         WHERE notice_id = ?",
        rusqlite::params![current.0, current.1, current.2, now_iso(), notice_id],
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, notice_id: &str) -> Result<()> {
    conn.execute("DELETE FROM board_items WHERE notice_id = ?", [notice_id])?;
    Ok(())
}

pub fn contains(conn: &Connection, notice_id: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM board_items WHERE notice_id = ?",
        [notice_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}
