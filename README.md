# rediscacheinnodejs
Create a mini redis cache using nodejs(typescript)

1: Implement a RESP server that can be used to store key value pairs where value is of string format. Other format can be added later as extension.
2: Should be developed as a single threaded model with concurrent requests queued to mimic the REDIS server.Nodejs therefore makes perfect sense as gives 
similar capabilities off the shelf.

# How to access
1: Start the server : 
  > ts-node mini-redis-server.ts

2: Install redis-cli to serve as Client to the RESP server
  > redis-cli -p 6379 PING
  # -> "PONG"

  > redis-cli -p 6379 SET mykey hello
  > redis-cli -p 6379 GET mykey
  # -> "hello"


