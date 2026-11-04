// Su Windows la versione distribuita non apre una console aggiuntiva.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cig_lib::run();
}
