#![forbid(unsafe_code)]
#![allow(dead_code)]

mod canonical;
mod crypto;
mod ipc;
mod journal;
mod protocol;
mod records;
mod state;

#[cfg(test)]
mod tests;
