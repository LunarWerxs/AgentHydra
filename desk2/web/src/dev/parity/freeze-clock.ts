// Parity renders freeze Date.now so elapsed labels, reset clocks and stats read the same on every run.
// Only ParityPage (the #/parity/ entry) imports this.
import { PARITY_NOW } from './clock'

Date.now = () => PARITY_NOW
