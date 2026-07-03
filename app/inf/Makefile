# Makefile for dece-semsaged, the DECE scorer HTTP gateway.
#
#   make            # build ./dece-semsaged
#   make run        # build, then run against $(MODEL)/$(BUS) (override on cmd line)
#   make clean      # remove build artifacts
#
# libsplinter is expected under /usr/local (override PREFIX or SPLINTER_* below).

CXX      ?= g++
PREFIX   ?= /usr/local

# Header search: cwd for httplib.h, PREFIX for splinter.h.
# CPPHTTPLIB_OPENSSL_SUPPORT lets httplib reach an https:// external embedder
# (SEMSAGE_EMBEDDING_URL); it pulls in -lssl -lcrypto (libssl-dev).
CPPFLAGS += -DSPLINTER_EMBEDDINGS -DSPLINTER_PERSISTENT -DCPPHTTPLIB_OPENSSL_SUPPORT -I. -I$(PREFIX)/include
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra
LDFLAGS  += -L$(PREFIX)/lib
LDLIBS   += -lsplinter_p -lpthread -lssl -lcrypto

TARGET   := dece-semsaged
SRC      := dece-semsaged.cpp
HDRS     := httplib.h

# Run defaults (override: make run MODEL=../../dece/Aldous_1-2/Aldous_1-2.dece BUS=../ipc/Aldous_1-2)
MODEL    ?= ../../dece/Aldous_1-2/Aldous_1-2.dece
BUS      ?= ../ipc/Aldous_1-2
JOURNAL  ?= dece-semsaged-journal.jsonl
PORT     ?= 8080

.PHONY: all run clean

all: $(TARGET)

$(TARGET): $(SRC) $(HDRS)
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(SRC) -o $@ $(LDFLAGS) $(LDLIBS)

run: $(TARGET)
	./$(TARGET) --model $(MODEL) --bus $(BUS) --journal $(JOURNAL) --port $(PORT)

clean:
	rm -f $(TARGET)
