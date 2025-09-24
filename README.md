# rediscacheinnodejs
Create a mini redis cache using nodejs(typescript)

1: Implement a RESP server that can be used to store key value pairs where value is of string format. Other format can be added later as extension.
2: Should be developed as a single threaded model with concurrent requests processed serially to simulate the REDIS server. 
3: Should store data all in memory for superior performance with ability to recover stored data in case of a system restart/crash.
3: Should evict Least Recently Used data to handle size issue since it's all in memory.
3: Should auto clean up the cache for expired key/Value pairs 

# How to access
1: Start the server : 
  > ts-node mini-redis-server.ts

2: Install redis-cli to serve as Client to the RESP server
  > redis-cli -p 6379 PING
  # -> "PONG"

  > redis-cli -p 6379 SET mykey hello
  > redis-cli -p 6379 GET mykey
  # -> "hello"


