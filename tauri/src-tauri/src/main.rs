#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    // Keep dev logs in the launching terminal without allocating another console.
    #[cfg(all(target_os = "windows", debug_assertions))]
    unsafe {
        use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
    mimi_lib::run();
}
