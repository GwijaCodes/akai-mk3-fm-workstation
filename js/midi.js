export function hasWebMIDIAccess() {
  return !!navigator.requestMIDIAccess;
}
