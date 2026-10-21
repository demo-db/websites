package nativereader_test

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"github.com/dal-go/dalgo/dal"
	"github.com/dal-go/record"
	"github.com/ingitdb/dalgo2ingitdb"
	"github.com/ingitdb/ingitdb-go/ingitdb"
	"github.com/ingitdb/ingitdb-go/ingitdb/config"
	"github.com/ingitdb/ingitdb-go/ingitdb/validator"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestActualGeneratedNativeArchive(t *testing.T) {
	file, err := os.Open(os.Getenv("NATIVE_PROVIDER_ARCHIVE"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	zipped, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer zipped.Close()
	archive := tar.NewReader(zipped)
	root := t.TempDir()
	for {
		entry, e := archive.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		if !filepath.IsLocal(entry.Name) || entry.Typeflag != tar.TypeReg {
			t.Fatal("unsafe generated archive")
		}
		path := filepath.Join(root, entry.Name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(archive)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, body, 0400); err != nil {
			t.Fatal(err)
		}
	}
	db, err := dalgo2ingitdb.NewDatabase(filepath.Join(root, "ingitdb"), validator.NewCollectionsReader(), dalgo2ingitdb.WithProtectedProfile(), dalgo2ingitdb.WithStoredOnlyReads())
	if err != nil {
		t.Fatal(err)
	}
	query := dal.From(dal.NewRootCollectionRef("baseline", "")).NewQuery().Limit(10).SelectIntoRecord(func() record.Record {
		return record.NewRecordWithData(record.NewKeyWithID("baseline", ""), map[string]any{})
	})
	rows, err := db.ExecuteQueryToRecordsReader(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	row, err := rows.Next()
	if err != nil {
		t.Fatal(err)
	}
	expectedKey := os.Getenv("NATIVE_EXPECTED_KEY")
	if expectedKey == "" {
		expectedKey = "e1"
	}
	if row.Key().ID != expectedKey || row.Data().(map[string]any)["synthetic"] != true {
		t.Fatal("native identity/type changed")
	}
	reopened := record.NewRecordWithData(record.NewKeyWithID("baseline", expectedKey), map[string]any{})
	if err := db.Get(context.Background(), reopened); err != nil {
		t.Fatal(err)
	}
	if reopened.Data().(map[string]any)["occurred_at"] != "2018-05-20T09:00:00Z" {
		t.Fatal("original field changed")
	}
	if _, err = rows.Next(); err != dal.ErrNoMoreRecords {
		t.Fatalf("unexpected extra record: %v", err)
	}
}

// Pin the owning library's configuration and key behavior, not a Python model.
func TestNativeConfigurationAndKeyParity(t *testing.T) {
	for _, tc := range []struct {
		name  string
		root  config.RootConfig
		valid bool
	}{
		{"supported languages", config.RootConfig{Settings: config.Settings{Languages: []config.Language{{Required: "en"}, {Optional: "fr"}}}, RootCollections: map[string]string{"baseline": "collections/baseline"}}, true},
		{"duplicate paths", config.RootConfig{RootCollections: map[string]string{"baseline": "collections/baseline", "alias": "collections/baseline"}}, false},
		{"language order", config.RootConfig{Settings: config.Settings{Languages: []config.Language{{Optional: "fr"}, {Required: "en"}}}, RootCollections: map[string]string{"baseline": "collections/baseline"}}, false},
		{"unicode identity", config.RootConfig{RootCollections: map[string]string{"é": "collections/baseline"}}, false},
		{"wildcard", config.RootConfig{RootCollections: map[string]string{"baseline": "collections/*"}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.root.Validate(); (err == nil) != tc.valid {
				t.Fatalf("actual native validation: %v", err)
			}
		})
	}
	definition := &ingitdb.CollectionDef{PrimaryKey: []string{"event_id", "part"}}
	a, okA := ingitdb.ResolveListRecordKey(map[string]any{"event_id": "x\x1fy", "part": "z"}, definition)
	b, okB := ingitdb.ResolveListRecordKey(map[string]any{"event_id": "x", "part": "y\x1fz"}, definition)
	if !okA || !okB || a != b || a != "x\x1fy\x1fz" {
		t.Fatal("native serialized-key contract changed")
	}
	valid, ok := ingitdb.ResolveListRecordKey(map[string]any{"event_id": "x", "part": "z"}, definition)
	if !ok || valid != "x\x1fz" {
		t.Fatal("native composite identity changed")
	}
}
