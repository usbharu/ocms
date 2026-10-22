// Package cryptostore implements the version 1 envelope format in specification §5.
package cryptostore

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"os"

	"gopkg.in/yaml.v3"
)

type Keyring struct {
	Active  string            `yaml:"active_key_id"`
	Encoded map[string]string `yaml:"keys"`
	keys    map[string][]byte
}

func Load(path string) (*Keyring, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, errors.New("cannot open key configuration")
	}
	defer f.Close()
	var k Keyring
	d := yaml.NewDecoder(f)
	d.KnownFields(true)
	if d.Decode(&k) != nil {
		return nil, errors.New("invalid key configuration")
	}
	k.keys = make(map[string][]byte)
	for id, value := range k.Encoded {
		key, err := base64.StdEncoding.DecodeString(value)
		if err != nil || len(key) != 32 || id == "" {
			return nil, errors.New("invalid master key")
		}
		k.keys[id] = key
	}
	if _, ok := k.keys[k.Active]; !ok {
		return nil, errors.New("active master key missing")
	}
	k.Encoded = nil
	return &k, nil
}
func Random(n int) []byte {
	b := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		panic("secure random source unavailable")
	}
	return b
}
func aad(id string) []byte { return []byte("media-storage:dek:v1:" + id) }
func (k *Keyring) Wrap(id string, dek []byte) (string, []byte, []byte, error) {
	key, ok := k.keys[k.Active]
	if !ok {
		return "", nil, nil, errors.New("active key unavailable")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", nil, nil, err
	}
	nonce := Random(gcm.NonceSize())
	return k.Active, gcm.Seal(nil, nonce, dek, aad(id)), nonce, nil
}
func (k *Keyring) Unwrap(id, keyID string, wrapped, nonce []byte) ([]byte, error) {
	key, ok := k.keys[keyID]
	if !ok {
		return nil, errors.New("master key unavailable")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, errors.New("invalid wrap nonce")
	}
	dek, err := gcm.Open(nil, nonce, wrapped, aad(id))
	if err != nil || len(dek) != 32 {
		return nil, errors.New("DEK unwrap failed")
	}
	return dek, nil
}
func Stream(dek, prefix []byte, offset int64) (cipher.Stream, error) {
	if len(dek) != 32 || len(prefix) != 8 || offset < 0 {
		return nil, errors.New("invalid CTR parameters")
	}
	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, err
	}
	counter := make([]byte, 16)
	copy(counter, prefix)
	binary.BigEndian.PutUint64(counter[8:], uint64(offset/16))
	stream := cipher.NewCTR(block, counter)
	skip := make([]byte, offset%16)
	stream.XORKeyStream(skip, skip)
	return stream, nil
}
