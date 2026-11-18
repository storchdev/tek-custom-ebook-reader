// Command ttu-sync is a tiny self-hosted sync server for the reader.
//
// It serves a WebDAV share (the reader's "WebDAV (self-hosted)" storage source)
// behind HTTP basic auth, and can optionally serve the built reader itself so
// the app and its data live on one origin.
//
//	TTU_USER=me TTU_PASS=secret ttu-sync -data /var/lib/ttu-sync -app ./build -addr :8080
//
// Put it behind a TLS reverse proxy (e.g. Caddy) when exposing it to the internet.
package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"flag"
	"log"
	"net/http"
	"os"
	"strings"

	"golang.org/x/net/webdav"
)

func main() {
	addr := flag.String("addr", envOr("TTU_ADDR", ":8080"), "listen address")
	dataDir := flag.String("data", envOr("TTU_DATA", "./data"), "directory that stores synced data")
	appDir := flag.String("app", envOr("TTU_APP", ""), "optional: directory with the built reader (apps/web/build) to serve at /")
	prefix := flag.String("prefix", envOr("TTU_PREFIX", "/dav/"), "url path of the WebDAV share")
	origins := flag.String("cors", envOr("TTU_CORS_ORIGINS", ""), "comma separated origins allowed to use the share from another site (e.g. https://reader.ttsu.app); empty = same origin only")
	flag.Parse()

	user, pass := os.Getenv("TTU_USER"), os.Getenv("TTU_PASS")
	if user == "" || pass == "" {
		log.Fatal("set TTU_USER and TTU_PASS")
	}
	if !strings.HasSuffix(*prefix, "/") {
		*prefix += "/"
	}
	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		log.Fatal(err)
	}

	dav := &webdav.Handler{
		Prefix:     strings.TrimSuffix(*prefix, "/"),
		FileSystem: webdav.Dir(*dataDir),
		LockSystem: webdav.NewMemLS(),
		Logger: func(r *http.Request, err error) {
			if err != nil && !os.IsNotExist(err) {
				log.Printf("%s %s: %v", r.Method, r.URL.Path, err)
			}
		},
	}

	allowed := map[string]bool{}
	for _, o := range strings.Split(*origins, ",") {
		if o = strings.TrimRight(strings.TrimSpace(o), "/"); o != "" {
			allowed[o] = true
		}
	}

	wantUser, wantPass := sha256.Sum256([]byte(user)), sha256.Sum256([]byte(pass))
	authorized := func(r *http.Request) bool {
		u, p, ok := r.BasicAuth()
		gotUser, gotPass := sha256.Sum256([]byte(u)), sha256.Sum256([]byte(p))
		return ok &&
			subtle.ConstantTimeCompare(gotUser[:], wantUser[:]) == 1 &&
			subtle.ConstantTimeCompare(gotPass[:], wantPass[:]) == 1
	}

	mux := http.NewServeMux()
	mux.HandleFunc(*prefix, func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); allowed[origin] {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Set("Access-Control-Allow-Methods", "GET, PUT, DELETE, MKCOL, MOVE, COPY, PROPFIND, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Depth, Destination, Overwrite")
			h.Set("Access-Control-Max-Age", "86400")
			h.Add("Vary", "Origin")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		if !authorized(r) {
			// no WWW-Authenticate header on purpose: it would make browsers show their own login popup
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		dav.ServeHTTP(w, r)
	})

	if *appDir != "" {
		mux.Handle("/", spa(*appDir))
	}

	log.Printf("ttu-sync on %s, WebDAV at %s, data in %s", *addr, *prefix, *dataDir)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

// spa serves the static build and falls back to the prerendered .html pages
// (SvelteKit static adapter writes /manage as manage.html).
func spa(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimSuffix(r.URL.Path, "/")
		if p != "" && !strings.Contains(p[strings.LastIndex(p, "/"):], ".") {
			if _, err := os.Stat(dir + p + ".html"); err == nil {
				r.URL.Path = p + ".html"
			}
		}
		files.ServeHTTP(w, r)
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
