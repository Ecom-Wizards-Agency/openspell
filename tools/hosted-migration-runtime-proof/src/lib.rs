#![deny(unsafe_code)]
#![allow(dead_code)]

mod archive;
mod canonical;
mod elf;
mod machine;
mod policy;
mod provenance;
mod ticket;

#[cfg(test)]
mod model_tests;

#[cfg(test)]
mod provenance_tests;
