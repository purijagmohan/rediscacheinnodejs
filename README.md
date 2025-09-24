# rediscacheinnodejs
Create a mini redis cache using nodejs(typescript)

1: Implement a RESP server that can be used to store key value pairs where value is of string format. Other format can be added later as extension.
2: Should be developed as a single threaded model with concurrent requests processed serially to simulate the REDIS server. 
3: Should store data all in memory for superior performance with ability to recover stored data in case of a system restart/crash.
4: Should evict Least Recently Used data to handle size issue since it's all in memory.
5: Should auto clean up the cache for expired key/Value pairs 

# How to access
1: Start the server : 
  > ts-node mini-redis-server.ts

2: Install redis-cli to serve as Client to the RESP server
  > redis-cli -p 6379
      > SET user1 "{\"name\":\"Alice\",\"age\":30}"  // Add Item to cache
      > GET user1  // Fetch Item from Cache
      > DEL user1  // Remove Item from Cache

      // Stats
      > INFO memory
      > INFO

      // TTL
      > EXPIRE user1 5  // Sets TTL to 5 seconds
      > TTL user1  // returns remaining time to live. Should get purged after TTL = 0
      

