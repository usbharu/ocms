package cryptostore

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestEnvelopeRotationAndRanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "crypto.yaml")
	oldKey, newKey := Random(32), Random(32)
	config := "active_key_id: old\nkeys:\n  old: " + base64.StdEncoding.EncodeToString(oldKey) + "\n  new: " + base64.StdEncoding.EncodeToString(newKey) + "\n"
	if err := os.WriteFile(path, []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	k, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	dek, prefix := Random(32), Random(8)
	id := "d161bcbf-0367-4566-ac21-21e40700a543"
	keyID, wrapped, nonce, err := k.Wrap(id, dek)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = k.Unwrap("another-blob", keyID, wrapped, nonce); err == nil {
		t.Fatal("AAD substitution accepted")
	}
	plaintext := Random(4097)
	ciphertext := make([]byte, len(plaintext))
	stream, _ := Stream(dek, prefix, 0)
	stream.XORKeyStream(ciphertext, plaintext)
	for _, offset := range []int64{0, 1, 15, 16, 17, 255, 4096} {
		decrypted := make([]byte, len(plaintext)-int(offset))
		s, err := Stream(dek, prefix, offset)
		if err != nil {
			t.Fatal(err)
		}
		s.XORKeyStream(decrypted, ciphertext[offset:])
		if !bytes.Equal(decrypted, plaintext[offset:]) {
			t.Fatalf("range %d differs", offset)
		}
	}
	restored, err := k.Unwrap(id, keyID, wrapped, nonce)
	if err != nil {
		t.Fatal(err)
	}
	k.Active = "new"
	keyID, wrapped, nonce, err = k.Wrap(id, restored)
	if err != nil {
		t.Fatal(err)
	}
	delete(k.keys, "old")
	restored, err = k.Unwrap(id, keyID, wrapped, nonce)
	if err != nil || !bytes.Equal(restored, dek) {
		t.Fatal("rewrap failed")
	}
	if _, err = Stream(dek, prefix, -1); err == nil {
		t.Fatal("negative offset accepted")
	}
}
func TestRejectInvalidKeyConfiguration(t *testing.T) {
	for _, data := range []string{"active_key_id: missing\nkeys: {}", "active_key_id: x\nkeys:\n  x: SECRET_NOT_A_KEY", "active_key_id: x\nkeys:\n  x: YQ==", "unknown: true"} {
		p := filepath.Join(t.TempDir(), "keys.yaml")
		os.WriteFile(p, []byte(data), 0600)
		if _, err := Load(p); err == nil {
			t.Fatal("invalid config accepted")
		}
	}
}
