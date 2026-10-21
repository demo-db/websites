package nativereader_test

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"github.com/dal-go/dalgo/dal"
	"github.com/dal-go/record"
	"github.com/ingitdb/dalgo2ingitdb"
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
	if row.Key().ID != "e1" || row.Data().(map[string]any)["synthetic"] != true {
		t.Fatal("native identity/type changed")
	}
	reopened := record.NewRecordWithData(record.NewKeyWithID("baseline", "e1"), map[string]any{})
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
