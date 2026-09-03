#![forbid(unsafe_code)]
#![allow(dead_code)]

mod canonical;

#[cfg(test)]
mod corruption_tests;

mod crypto;
mod ipc;
mod journal;
mod protocol;
mod records;
mod state;

#[cfg(test)]
mod mutation_tests;

#[cfg(test)]
mod policy_matrix_tests;

#[cfg(test)]
mod tests;
