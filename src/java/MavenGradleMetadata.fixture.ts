/** Tiny well-formed Maven POM with parent, properties, BOM import, and ranges. */
export const mavenPomFixture = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>demo-parent</artifactId>
    <version>9.0.0</version>
    <relativePath>../pom.xml</relativePath>
  </parent>
  <artifactId>demo</artifactId>
  <version>\${revision}</version>
  <packaging>jar</packaging>
  <properties>
    <revision>1.2.3</revision>
    <jackson.version>2.17.2</jackson.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-dependencies</artifactId>
        <version>3.3.4</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
      <dependency>
        <groupId>com.fasterxml.jackson.core</groupId>
        <artifactId>jackson-databind</artifactId>
        <version>\${jackson.version}</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <scope>compile</scope>
      <optional>false</optional>
      <exclusions>
        <exclusion>
          <groupId>com.fasterxml.jackson.core</groupId>
          <artifactId>jackson-annotations</artifactId>
        </exclusion>
      </exclusions>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>[5.10,6.0)</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
`;

/** Tiny Gradle Module Metadata 1.1 document with library and platform variants. */
export const gradleModuleFixture = `{
  "formatVersion": "1.1",
  "component": {
    "group": "com.example",
    "module": "demo",
    "version": "1.2.3"
  },
  "createdBy": {
    "gradle": {
      "version": "8.10.2"
    }
  },
  "variants": [
    {
      "name": "apiElements",
      "attributes": {
        "org.gradle.usage": "java-api",
        "org.gradle.category": "library"
      },
      "dependencies": [
        {
          "group": "com.fasterxml.jackson.core",
          "module": "jackson-databind",
          "version": { "requires": "2.17.2" },
          "excludes": [
            {
              "group": "com.fasterxml.jackson.core",
              "module": "jackson-annotations"
            }
          ]
        }
      ]
    },
    {
      "name": "runtimeElements",
      "attributes": {
        "org.gradle.usage": "java-runtime",
        "org.gradle.category": "library"
      },
      "dependencyConstraints": [
        {
          "group": "org.slf4j",
          "module": "slf4j-api",
          "version": { "requires": "2.0.16" }
        }
      ]
    },
    {
      "name": "demoPlatform",
      "attributes": {
        "org.gradle.category": "platform"
      },
      "dependencyConstraints": [
        {
          "group": "com.fasterxml.jackson.core",
          "module": "jackson-databind",
          "version": { "strictly": "[2.17,2.18)" }
        }
      ]
    }
  ]
}
`;
