package com.lonelycat.ot;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 读取共享测试向量 ot-test-vectors.json 逐条验证。
 * 前端的 ot-core 用同一份文件跑同样的断言，保证两边算法行为一致。
 */
class TransformVectorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static JsonNode loadVectors() throws Exception {
        try (InputStream in = TransformVectorTest.class.getResourceAsStream("/ot-test-vectors.json")) {
            return MAPPER.readTree(in);
        }
    }

    private static TextOperation op(JsonNode arrayNode) throws Exception {
        List<?> list = MAPPER.treeToValue(arrayNode, List.class);
        return TextOperation.fromJson(list);
    }

    @TestFactory
    List<DynamicTest> applyVectors() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : loadVectors().get("apply")) {
            tests.add(DynamicTest.dynamicTest("apply: " + c.get("name").asText(), () -> {
                String actual = op(c.get("op")).apply(c.get("doc").asText());
                assertEquals(c.get("expected").asText(), actual);
            }));
        }
        return tests;
    }

    @TestFactory
    List<DynamicTest> composeVectors() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : loadVectors().get("compose")) {
            tests.add(DynamicTest.dynamicTest("compose: " + c.get("name").asText(), () -> {
                TextOperation a = op(c.get("a"));
                TextOperation b = op(c.get("b"));
                TextOperation expected = op(c.get("expected"));
                String doc = c.get("doc").asText();

                TextOperation composed = OtEngine.compose(a, b);
                // 结构上等于期望的规范形式
                assertEquals(expected.toJson(), composed.toJson());
                // 语义上等价：分两步应用 == 合并后一步应用
                assertEquals(b.apply(a.apply(doc)), composed.apply(doc));
            }));
        }
        return tests;
    }

    @TestFactory
    List<DynamicTest> transformVectors() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : loadVectors().get("transform")) {
            tests.add(DynamicTest.dynamicTest("transform: " + c.get("name").asText(), () -> {
                TextOperation a = op(c.get("a"));
                TextOperation b = op(c.get("b"));
                String doc = c.get("doc").asText();

                OtEngine.TransformResult r = OtEngine.transform(a, b);
                assertEquals(op(c.get("aPrime")).toJson(), r.aPrime().toJson(), "a' 不符");
                assertEquals(op(c.get("bPrime")).toJson(), r.bPrime().toJson(), "b' 不符");

                // 两条路径都要收敛到同一个结果
                String viaA = r.bPrime().apply(a.apply(doc));
                String viaB = r.aPrime().apply(b.apply(doc));
                assertEquals(c.get("result").asText(), viaA, "先 a 后 b' 的结果不符");
                assertEquals(c.get("result").asText(), viaB, "先 b 后 a' 的结果不符");
            }));
        }
        return tests;
    }
}
